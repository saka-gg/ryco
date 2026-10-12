// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

import type { UsageProviderKind } from "@ryco/contracts";

import type { UsageRecord } from "./usageRecord.ts";
import { withTokenTotal } from "./usageRecord.ts";

/** v5: session/response hashes are truncated to {@link SCAN_CACHE_IDENTIFIER_LENGTH}. */
export const USAGE_SCAN_CACHE_VERSION = 5 as const;

/**
 * Hex digits kept for anonymized session/response identifiers of scan-cached
 * records. 64 bits keep collisions negligible (~3e-8 at 10^6 records) and
 * shrink the cache by about a quarter versus full SHA-256 digests.
 */
export const SCAN_CACHE_IDENTIFIER_LENGTH = 16;

/** Upper bound on files and records decoded from one serialized cache document. */
const MAX_DECODED_FILES = 10_000;
const MAX_RECORDS_PER_FILE = 100_000;

export interface CachedUsageFile {
  readonly rootKey: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
  readonly fingerprint?: string;
}

export type UsageScanCache = Map<string, CachedUsageFile>;

export function matchesUsageFileCache(
  cached: CachedUsageFile | undefined,
  file: { readonly size: number; readonly mtimeMs: number; readonly fingerprint?: string },
  provider: UsageProviderKind,
): cached is CachedUsageFile {
  return (
    cached !== undefined &&
    cached.provider === provider &&
    cached.size === file.size &&
    cached.mtimeMs === file.mtimeMs &&
    cached.fingerprint === file.fingerprint
  );
}

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
  reasoningTokens: number | null,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  authoritativeTotal?: number,
  speed?: "standard" | "fast" | "ultrafast" | null,
];

interface SerializedFile {
  readonly f?: string;
  readonly o: string;
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

function hashPrivateIdentifier(kind: string, value: string, length = 64): string {
  const digest = createHash("sha256").update(`${kind}\0${value}`).digest("hex");
  return length >= digest.length ? digest : digest.slice(0, length);
}

export function usageCacheFileKey(provider: UsageProviderKind, canonicalPath: string): string {
  return hashPrivateIdentifier(`${provider}:transcript-file`, canonicalPath);
}

export function usageCacheRootKey(provider: UsageProviderKind, canonicalRoot: string): string {
  return hashPrivateIdentifier(`${provider}:transcript-root`, canonicalRoot);
}

function anonymize(record: UsageRecord, identifierLength: number): UsageRecord {
  return {
    ...record,
    sessionId:
      record.sessionId.length === 0
        ? ""
        : hashPrivateIdentifier(`${record.provider}:session`, record.sessionId, identifierLength),
    dedupeKey:
      record.dedupeKey === null
        ? null
        : hashPrivateIdentifier(`${record.provider}:response`, record.dedupeKey, identifierLength),
  };
}

/** Remove provider session/message identifiers before a parsed row becomes durable. */
export function anonymizeUsageRecord(record: UsageRecord): UsageRecord {
  return anonymize(record, 64);
}

/**
 * {@link anonymizeUsageRecord} for records kept in the scan cache. Every record
 * of one source must use the same form: deduplication compares these keys.
 */
export function anonymizeScanCachedUsageRecord(record: UsageRecord): UsageRecord {
  return anonymize(record, SCAN_CACHE_IDENTIFIER_LENGTH);
}

export function deduplicateUsageRecordsWithinFile(
  records: readonly UsageRecord[],
): readonly UsageRecord[] {
  const seen = new Set<string>();
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}

export function encodeUsageScanCache(cache: UsageScanCache): SerializedCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndexes = new Map<string, number>();
  const sessionIndexes = new Map<string, number>();
  const intern = (values: string[], indexes: Map<string, number>, value: string): number => {
    const existing = indexes.get(value);
    if (existing !== undefined) return existing;
    const next = values.length;
    values.push(value);
    indexes.set(value, next);
    return next;
  };

  const files: Record<string, SerializedFile> = {};
  for (const [fileKey, entry] of cache) {
    files[fileKey] = {
      o: entry.rootKey,
      ...(entry.fingerprint === undefined ? {} : { f: entry.fingerprint }),
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      r: entry.records.map((record) => [
        record.timestampMs,
        intern(models, modelIndexes, record.model),
        intern(sessions, sessionIndexes, record.sessionId),
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationInputTokens,
        record.totals.outputTokens,
        record.totals.reasoningTokens ?? null,
        record.dedupeKey,
        record.reportedCostUsd,
        record.totals.totalTokens,
        record.speed ?? null,
      ]),
    };
  }
  return { version: USAGE_SCAN_CACHE_VERSION, models, sessions, files };
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function decodeUsageScanCache(document: unknown): UsageScanCache {
  const cache: UsageScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;
  const root = document as Partial<SerializedCache>;
  if (
    (root.version !== USAGE_SCAN_CACHE_VERSION &&
      root.version !== 2 &&
      root.version !== 3 &&
      root.version !== 4) ||
    !isArray(root.models) ||
    !root.models.every((value) => typeof value === "string") ||
    !isArray(root.sessions) ||
    !root.sessions.every((value) => typeof value === "string") ||
    typeof root.files !== "object" ||
    root.files === null
  ) {
    return cache;
  }

  if (
    root.models.length > 50_000 ||
    root.sessions.length > 250_000 ||
    Object.keys(root.files).length > MAX_DECODED_FILES
  )
    return cache;
  const models = root.models as readonly string[];
  // Before v5 identifiers were full SHA-256 digests; their prefix is the compact form.
  const compact = (value: string) =>
    root.version === USAGE_SCAN_CACHE_VERSION
      ? value
      : value.slice(0, SCAN_CACHE_IDENTIFIER_LENGTH);
  const sessions = (root.sessions as readonly string[]).map(compact);
  for (const [fileKey, rawEntry] of Object.entries(root.files)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Partial<SerializedFile>;
    // Old transcript rows did not retain speed; rescan them rather than price as standard.
    if ((root.version === 2 || root.version === 3) && (entry.p === "codex" || entry.p === "claude"))
      continue;
    if (
      typeof entry.o !== "string" ||
      entry.o.length === 0 ||
      typeof entry.s !== "number" ||
      !Number.isFinite(entry.s) ||
      typeof entry.m !== "number" ||
      !Number.isFinite(entry.m) ||
      !["claude", "codex", "cursor", "opencode"].includes(entry.p ?? "") ||
      !isArray(entry.r)
    ) {
      continue;
    }

    if (entry.r.length > MAX_RECORDS_PER_FILE) continue;
    const records: UsageRecord[] = [];
    let corrupt = false;
    for (const rawRow of entry.r) {
      if (!isArray(rawRow) || rawRow.length < 10) {
        corrupt = true;
        break;
      }
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        authoritativeTotal,
        rawSpeed,
      ] = rawRow as SerializedRecord;
      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      const sessionId = typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined;
      const tokens = [uncached, cached, cacheCreation, output];
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        timestampMs < 0 ||
        timestampMs > 8.64e15 ||
        (authoritativeTotal !== undefined &&
          (typeof authoritativeTotal !== "number" ||
            !Number.isFinite(authoritativeTotal) ||
            authoritativeTotal < 0)) ||
        model === undefined ||
        sessionId === undefined ||
        (reasoning !== null &&
          (typeof reasoning !== "number" || !Number.isFinite(reasoning) || reasoning < 0)) ||
        tokens.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
        (dedupeKey !== null && typeof dedupeKey !== "string") ||
        (reportedCostUsd !== null &&
          (typeof reportedCostUsd !== "number" ||
            !Number.isFinite(reportedCostUsd) ||
            reportedCostUsd < 0))
      ) {
        corrupt = true;
        break;
      }

      const speed = rawSpeed ?? undefined;
      if (
        speed !== undefined &&
        speed !== "standard" &&
        speed !== "fast" &&
        speed !== "ultrafast"
      ) {
        corrupt = true;
        break;
      }
      records.push({
        ...(speed === undefined ? {} : { speed }),
        provider: entry.p as UsageProviderKind,
        timestampMs,
        model,
        sessionId,
        totals: {
          ...withTokenTotal({
            uncachedInputTokens: uncached,
            cachedInputTokens: cached,
            cacheCreationInputTokens: cacheCreation,
            outputTokens: output,
            ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
          }),
          ...(authoritativeTotal === undefined ? {} : { totalTokens: authoritativeTotal }),
        },
        dedupeKey: dedupeKey === null ? null : compact(dedupeKey),
        reportedCostUsd,
      });
    }
    if (!corrupt) {
      cache.set(fileKey, {
        rootKey: entry.o,
        ...(typeof entry.f === "string" ? { fingerprint: entry.f } : {}),
        size: entry.s,
        mtimeMs: entry.m,
        provider: entry.p as UsageProviderKind,
        records,
      });
    }
  }
  return cache;
}

/**
 * Bound the records held in memory. Evicts the least recently modified files
 * first, so the files most likely to be requested (and to still change) stay.
 * Returns the number of evicted files.
 */
export function capUsageScanCache(cache: UsageScanCache, maxRecords: number): number {
  let total = 0;
  for (const entry of cache.values()) total += entry.records.length;
  if (total <= maxRecords) return 0;
  const oldestFirst = [...cache].toSorted(([, left], [, right]) => left.mtimeMs - right.mtimeMs);
  let removed = 0;
  for (const [fileKey, entry] of oldestFirst) {
    if (total <= maxRecords) break;
    cache.delete(fileKey);
    total -= entry.records.length;
    removed += 1;
  }
  return removed;
}

export interface PruneUsageScanCacheOptions {
  readonly liveFileKeys: ReadonlySet<string>;
  readonly walkedRootKeys: ReadonlySet<string>;
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
}

export function pruneUsageScanCache(
  cache: UsageScanCache,
  options: PruneUsageScanCacheOptions,
): number {
  let removed = 0;
  for (const [fileKey, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const underWalkedRoot = options.walkedRootKeys.has(entry.rootKey);
    const deleted =
      underWalkedRoot &&
      entry.mtimeMs >= options.windowStartMs &&
      !options.liveFileKeys.has(fileKey);
    if (agedOut || deleted) {
      cache.delete(fileKey);
      removed += 1;
    }
  }
  return removed;
}
