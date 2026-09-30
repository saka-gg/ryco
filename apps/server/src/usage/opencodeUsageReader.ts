// Provider-native metadata only. Never query parts, credentials, or message content.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";

import type { UsageSourceStatus } from "@ryco/contracts";

import { readBoundedUsageFile } from "./usageFileReader.ts";
import { withTokenTotal, type UsageRecord } from "./usageRecord.ts";
import {
  anonymizeUsageRecord,
  deduplicateUsageRecordsWithinFile,
  usageCacheFileKey,
  usageCacheRootKey,
  type UsageScanCache,
} from "./usageScanCache.ts";

export const OPENCODE_USAGE_LIMITS = {
  databaseBytes: 512 * 1024 * 1024,
  recordBytes: 1024 * 1024,
  scanBytes: 64 * 1024 * 1024,
  entries: 50_000,
  depth: 4,
  pageSize: 32,
  durationMs: 5_000,
} as const;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" && value.length <= 512 && !value.includes("\0") ? value : "";
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type OpenCodeMessageResult =
  | { readonly kind: "record"; readonly record: UsageRecord }
  | { readonly kind: "skip" | "missing-telemetry" | "malformed" };

/** v1 AssistantMessage and v2 SessionMessage.Assistant, as published by OpenCode. */
export function parseOpenCodeUsageMessage(
  value: unknown,
  identity?: {
    readonly id: unknown;
    readonly sessionId: unknown;
    readonly created: unknown;
  },
): OpenCodeMessageResult {
  const message = object(value);
  if (message.role !== "assistant" && message.type !== "assistant") return { kind: "skip" };
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  if (message.tokens == null) return { kind: "missing-telemetry" };
  if (![usage.input, usage.output, usage.reasoning, cache.read, cache.write].every(count)) {
    return { kind: "malformed" };
  }
  const model = text(message.modelID) || text(object(message.model).id);
  const id = text(identity?.id ?? message.id);
  const sessionId = text(identity?.sessionId ?? message.sessionID);
  const timestampMs = object(message.time).created ?? identity?.created;
  if (!model || !id || !sessionId || !count(timestampMs) || timestampMs > 8.64e15) {
    return { kind: "malformed" };
  }
  const calculated = withTokenTotal({
    uncachedInputTokens: usage.input as number,
    cachedInputTokens: cache.read as number,
    cacheCreationInputTokens: cache.write as number,
    // OpenCode stores visible output and reasoning separately.
    outputTokens: (usage.output as number) + (usage.reasoning as number),
    reasoningTokens: usage.reasoning as number,
  });
  if (usage.total !== undefined) {
    if (!count(usage.total)) return { kind: "malformed" };
  }
  const totals = {
    ...calculated,
    totalTokens: usage.total === undefined ? calculated.totalTokens : (usage.total as number),
  };
  if (!Number.isSafeInteger(totals.totalTokens) || !Number.isSafeInteger(totals.outputTokens)) {
    return { kind: "malformed" };
  }
  // An unfinished zero row is not proof that a response consumed no tokens.
  if (totals.totalTokens === 0 && object(message.time).completed == null) {
    return { kind: "missing-telemetry" };
  }
  const cost = message.cost;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) {
    return { kind: "malformed" };
  }
  return {
    kind: "record",
    record: {
      provider: "opencode",
      timestampMs,
      model,
      sessionId,
      totals,
      // OpenCode writes 0 when a model has no rate. Zero is not a billing assertion.
      reportedCostUsd: typeof cost === "number" && cost > 0 ? cost : null,
      dedupeKey: id,
    },
  };
}

export interface OpenCodeUsageResult {
  readonly records: readonly UsageRecord[];
  readonly status: UsageSourceStatus;
  readonly diagnosticCode?: string;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly reusedCacheFileCount: number;
  readonly skippedCount: number;
  readonly malformedCount: number;
  readonly liveFileKeys: ReadonlySet<string>;
  readonly cacheChanged: boolean;
}

/** Checks every descendant component; links never broaden the configured root. */
async function safeStat(root: string, target: string) {
  const relative = Path.relative(root, target);
  if (relative.startsWith("..") || Path.isAbsolute(relative)) throw new Error("outside-root");
  let current = root;
  let stat = await FS.lstat(current);
  if (stat.isSymbolicLink()) throw new Error("symbolic-link");
  for (const part of relative.split(Path.sep).filter(Boolean)) {
    current = Path.join(current, part);
    stat = await FS.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic-link");
  }
  return stat;
}

function missing(error: unknown): boolean {
  return object(error).code === "ENOENT";
}

export async function readOpenCodeUsage(input: {
  readonly root: string;
  readonly databasePath: string;
  readonly cache: UsageScanCache;
  readonly signal?: AbortSignal;
  readonly allowLegacy?: boolean;
  readonly limits?: Partial<Record<keyof typeof OPENCODE_USAGE_LIMITS, number>>;
}): Promise<OpenCodeUsageResult> {
  const limits = { ...OPENCODE_USAGE_LIMITS, ...input.limits };
  const started = Date.now();
  let entries = 0,
    bytes = 0,
    files = 0,
    parsed = 0,
    reused = 0,
    skipped = 0,
    malformed = 0;
  let diagnostic: string | undefined,
    unsupported = false,
    found = false,
    cacheChanged = false;
  const records: UsageRecord[] = [];
  const liveFileKeys = new Set<string>();
  const rootKey = usageCacheRootKey("opencode", input.root);
  const check = () => {
    input.signal?.throwIfAborted();
    if (
      entries >= limits.entries ||
      bytes >= limits.scanBytes ||
      Date.now() - started >= limits.durationMs
    ) {
      diagnostic = "history-scan-limit";
      return false;
    }
    return true;
  };
  const accept = (value: unknown, identity?: Parameters<typeof parseOpenCodeUsageMessage>[1]) => {
    const result = parseOpenCodeUsageMessage(value, identity);
    if (result.kind === "record") records.push(anonymizeUsageRecord(result.record));
    else if (result.kind === "malformed") {
      malformed++;
      diagnostic ??= "history-record-invalid";
    } else if (result.kind === "missing-telemetry") {
      skipped++;
      diagnostic ??= "history-telemetry-missing";
    } else skipped++;
  };
  const databaseFingerprint = async () => {
    const components: string[] = [];
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const stat = await safeStat(input.root, input.databasePath + suffix);
        if (!stat.isFile() || stat.size > limits.databaseBytes) throw new Error("database-limit");
        // SHM changes during reads. Check permissions, but do not key the cache on it.
        if (suffix !== "-shm")
          components.push(
            suffix === "-wal" && stat.size === 0
              ? "absent"
              : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
          );
      } catch (error) {
        if (suffix !== "" && missing(error)) {
          if (suffix !== "-shm") components.push("absent");
        } else throw error;
      }
    }
    return components.join("|");
  };
  const databaseFileKey = usageCacheFileKey("opencode", input.databasePath);
  let checkingFinalIdentity = false;
  let db: DatabaseSync | undefined;
  try {
    const fingerprint = await databaseFingerprint();
    found = true;
    files++;
    const fileKey = usageCacheFileKey("opencode", input.databasePath);
    liveFileKeys.add(fileKey);
    const cached = input.cache.get(fileKey);
    if (cached?.fingerprint === fingerprint && cached.provider === "opencode") {
      records.push(...cached.records);
      reused++;
      checkingFinalIdentity = true;
      if ((await databaseFingerprint()) !== fingerprint) throw new Error("changed-store");
      checkingFinalIdentity = false;
    } else {
      db = new DatabaseSync(input.databasePath, { readOnly: true });
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 50; BEGIN");
      // A v2 store can retain migrated v1 tables. They contain distinct sessions;
      // response IDs remain the cross-table deduplication key.
      let recognized = false;
      for (const table of ["session_message", "message"] as const) {
        if (!check()) break;
        const columnInfo = db.prepare(`PRAGMA table_info(${table})`).all();
        const columns = new Set(columnInfo.map((row) => row.name));
        if (columns.size === 0) continue;
        if (
          !columnInfo.some((row) => row.name === "id" && row.pk === 1) ||
          !["id", "session_id", "time_created", "data"].every((name) => columns.has(name)) ||
          (table === "session_message" && !columns.has("type"))
        ) {
          unsupported = true;
          diagnostic ??= "history-format-unsupported";
          continue;
        }
        recognized = true;
        // JSON projection is guarded by size/validity. Neither content nor raw
        // data leaves SQLite; malformed and oversized rows still get diagnostics.
        const statement = db.prepare(`SELECT id, session_id, time_created AS created,
          length(CAST(data AS BLOB)) AS bytes,
          CASE WHEN length(CAST(data AS BLOB)) > ? THEN NULL WHEN json_valid(data) THEN json_type(data, '$.tokens.total') END AS total_type,
          CASE WHEN length(CAST(data AS BLOB)) > ? THEN NULL WHEN json_valid(data) THEN json_extract(data, '$.tokens.total') END AS total,
          CASE WHEN length(CAST(data AS BLOB)) > ? THEN NULL WHEN json_valid(data) THEN json_object(
            'role', json_extract(data, '$.role'), 'type', ${table === "session_message" ? "type" : "json_extract(data, '$.type')"},
            'modelID', json_extract(data, '$.modelID'), 'model', json_object('id', json_extract(data, '$.model.id')),
            'time', json_object('created', json_extract(data, '$.time.created'), 'completed', json_extract(data, '$.time.completed')),
            'tokens', CASE WHEN json_type(data, '$.tokens') = 'object' THEN json_object(
              'input', json_extract(data, '$.tokens.input'), 'output', json_extract(data, '$.tokens.output'),
              'reasoning', json_extract(data, '$.tokens.reasoning'),
              'cache', json_object('read', json_extract(data, '$.tokens.cache.read'), 'write', json_extract(data, '$.tokens.cache.write'))) END,
            'cost', json_extract(data, '$.cost')) END AS metadata
          FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`);
        let cursor = "";
        while (check()) {
          const page = statement.all(
            limits.recordBytes,
            limits.recordBytes,
            limits.recordBytes,
            cursor,
            Math.min(limits.pageSize, limits.entries - entries),
          );
          if (page.length === 0) break;
          for (const row of page) {
            if (!check()) break;
            entries++;
            cursor = typeof row.id === "string" ? row.id : "";
            bytes += typeof row.bytes === "number" ? row.bytes : limits.recordBytes;
            if (typeof row.metadata !== "string") {
              malformed++;
              diagnostic ??= "history-record-invalid-or-oversized";
              continue;
            }
            const metadata = JSON.parse(row.metadata);
            if (row.total_type !== null)
              metadata.tokens = { ...object(metadata.tokens), total: row.total };
            accept(metadata, { id: row.id, sessionId: row.session_id, created: row.created });
          }
          await setImmediate(undefined, { signal: input.signal });
          if (page.length < limits.pageSize) break;
        }
      }
      if (!recognized) {
        unsupported = true;
        diagnostic ??= "history-format-unsupported";
      }
      db.exec("ROLLBACK");
      db.close();
      db = undefined;
      parsed++;
      checkingFinalIdentity = true;
      if ((await databaseFingerprint()) !== fingerprint) {
        records.length = 0;
        diagnostic = "history-changed-during-scan";
      }
      checkingFinalIdentity = false;
      if (diagnostic === undefined) {
        const stat = await safeStat(input.root, input.databasePath);
        input.cache.set(fileKey, {
          rootKey,
          provider: "opencode",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          fingerprint,
          records: deduplicateUsageRecordsWithinFile(records),
        });
        cacheChanged = true;
      } else if (input.cache.delete(fileKey)) cacheChanged = true;
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (found) {
      records.length = 0;
      if (input.cache.delete(databaseFileKey)) cacheChanged = true;
      diagnostic = checkingFinalIdentity
        ? "history-changed-during-scan"
        : "history-database-unreadable";
    } else if (!missing(error)) {
      found = true;
      diagnostic ??= "history-database-unreadable";
    }
  } finally {
    db?.close();
  }

  // SQLite is authoritative after migration. Do not resurrect stale JSON copies
  // (or fall back to them when a present database is corrupt/unsupported).
  if (!found && input.allowLegacy !== false) {
    const directories = [{ path: Path.join(input.root, "storage", "message"), depth: 0 }];
    while (directories.length && check()) {
      const directory = directories.pop()!;
      try {
        const stat = await safeStat(input.root, directory.path);
        if (!stat.isDirectory()) throw new Error("not-directory");
        found = true;
        const handle = await FS.opendir(directory.path);
        for await (const entry of handle) {
          if (!check()) break;
          entries++;
          const child = Path.join(directory.path, entry.name);
          if (entry.isDirectory()) {
            if (directory.depth >= limits.depth) diagnostic ??= "history-scan-limit";
            else directories.push({ path: child, depth: directory.depth + 1 });
          } else if (entry.isFile() && /^msg_[\w-]+\.json$/.test(entry.name)) {
            files++;
            const fileKey = usageCacheFileKey("opencode", child);
            liveFileKeys.add(fileKey);
            const before = await safeStat(input.root, child);
            if (before.size > limits.recordBytes) {
              malformed++;
              diagnostic ??= "history-record-oversized";
              continue;
            }
            bytes += before.size;
            // No cache for legacy files: metadata may be edited with restored mtime.
            try {
              accept(
                JSON.parse(await readBoundedUsageFile(child, limits.recordBytes, input.signal)),
              );
              parsed++;
            } catch (error) {
              input.signal?.throwIfAborted();
              malformed++;
              diagnostic ??= text(object(error).code) || "history-record-invalid";
            }
          } else if (entry.isSymbolicLink()) diagnostic ??= "history-path-rejected";
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!missing(error)) diagnostic ??= "history-file-unreadable";
      }
      await setImmediate(undefined, { signal: input.signal });
    }
  }
  return {
    records: deduplicateUsageRecordsWithinFile(records),
    status:
      unsupported && records.length === 0
        ? "unsupported"
        : diagnostic !== undefined
          ? records.length > 0
            ? "partial"
            : "failed"
          : found
            ? "complete"
            : "not-found",
    ...(diagnostic === undefined ? {} : { diagnosticCode: diagnostic }),
    fileCount: files,
    parsedFileCount: parsed,
    reusedCacheFileCount: reused,
    skippedCount: skipped,
    malformedCount: malformed,
    liveFileKeys,
    cacheChanged,
  };
}
