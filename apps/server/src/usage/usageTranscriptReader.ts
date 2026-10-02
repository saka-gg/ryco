// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@ryco/contracts";

import { parseClaudeTranscriptLine } from "./claudeTranscript.ts";
import {
  initialCodexTranscriptState,
  parseCodexTranscriptLine,
  type CodexTranscriptState,
} from "./codexTranscript.ts";
import { mightCarryUsage, type UsageRecord } from "./usageRecord.ts";

export const USAGE_TRANSCRIPT_LIMITS = {
  entries: 50_000,
  files: 10_000,
  depth: 16,
  fileBytes: 64 * 1024 * 1024,
  lineBytes: 1024 * 1024,
  records: 100_000,
} as const;

export interface UsageTranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly fingerprint?: string;
}
export interface UsageTranscriptListing {
  readonly files: readonly UsageTranscriptFile[];
  readonly skippedEntryCount: number;
  readonly errorCount: number;
}

export async function listUsageTranscriptFiles(
  root: string,
  modifiedAfterMs: number,
  signal?: AbortSignal,
): Promise<UsageTranscriptListing> {
  const files: UsageTranscriptFile[] = [];
  let skippedEntryCount = 0,
    errorCount = 0,
    count = 0;
  const directories = [{ path: root, depth: 0 }];
  while (
    directories.length &&
    count < USAGE_TRANSCRIPT_LIMITS.entries &&
    files.length < USAGE_TRANSCRIPT_LIMITS.files
  ) {
    signal?.throwIfAborted();
    const directory = directories.pop()!;
    try {
      const directoryStat = await NodeFSP.lstat(directory.path);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        errorCount++;
        continue;
      }
      const entries = await NodeFSP.opendir(directory.path);
      for await (const entry of entries) {
        signal?.throwIfAborted();
        if (
          ++count >= USAGE_TRANSCRIPT_LIMITS.entries ||
          files.length >= USAGE_TRANSCRIPT_LIMITS.files
        ) {
          errorCount++;
          break;
        }
        const child = NodePath.join(directory.path, entry.name);
        if (entry.isSymbolicLink()) {
          errorCount++;
          continue;
        }
        if (entry.isDirectory()) {
          if (directory.depth >= USAGE_TRANSCRIPT_LIMITS.depth) errorCount++;
          else directories.push({ path: child, depth: directory.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          skippedEntryCount++;
          continue;
        }
        try {
          const stat = await NodeFSP.lstat(child);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            errorCount++;
            continue;
          }
          if (stat.mtimeMs >= modifiedAfterMs)
            files.push({
              path: child,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              fingerprint: `${stat.dev}:${stat.ino}:${stat.ctimeMs}`,
            });
          else skippedEntryCount++;
        } catch {
          errorCount++;
        }
      }
    } catch {
      signal?.throwIfAborted();
      errorCount++;
    }
  }
  if (directories.length) errorCount++;
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skippedEntryCount, errorCount };
}

export interface UsageTranscriptReadResult {
  readonly records: readonly UsageRecord[];
  readonly skippedLineCount: number;
  readonly malformedLineCount: number;
  readonly limited: boolean;
  /** Complete lines reused after validating their byte prefix. */
  readonly reusedLineCount: number;
}
function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

interface TranscriptCheckpoint {
  readonly provider: UsageProviderKind;
  readonly device: number;
  readonly inode: number;
  readonly offset: number;
  readonly digest: string;
  readonly state: CodexTranscriptState;
  readonly records: readonly UsageRecord[];
  readonly skippedLineCount: number;
  readonly malformedLineCount: number;
  readonly lineCount: number;
  readonly retainedBytes: number;
}

/** Keep parser checkpoints in memory only; never persist provider transcript state. */
export function createUsageTranscriptReader() {
  const checkpoints = new Map<string, TranscriptCheckpoint>();
  let retainedRecords = 0;
  let retainedBytes = 0;
  return async (filePath: string, provider: UsageProviderKind, signal?: AbortSignal) => {
    const previous = checkpoints.get(filePath);
    const remove = (key: string) => {
      const entry = checkpoints.get(key);
      if (entry) {
        retainedRecords -= entry.records.length;
        retainedBytes -= entry.retainedBytes;
      }
      checkpoints.delete(key);
    };
    const result = await readTranscript(filePath, provider, signal, previous, (checkpoint) => {
      remove(filePath);
      checkpoints.set(filePath, checkpoint);
      retainedRecords += checkpoint.records.length;
      retainedBytes += checkpoint.retainedBytes;
      while (checkpoints.size > 0) {
        if (
          checkpoints.size <= 128 &&
          retainedRecords <= USAGE_TRANSCRIPT_LIMITS.records &&
          retainedBytes <= 32 * 1024 * 1024
        )
          break;
        const oldest = checkpoints.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
    });
    if (result === null || result.limited) remove(filePath);
    return result;
  };
}

/** Bounded lines: readline's unbounded accumulation is unsafe for partial files. */
export async function readUsageTranscript(
  filePath: string,
  provider: UsageProviderKind,
  signal?: AbortSignal,
): Promise<UsageTranscriptReadResult | null> {
  return readTranscript(filePath, provider, signal);
}

async function readTranscript(
  filePath: string,
  provider: UsageProviderKind,
  signal?: AbortSignal,
  previous?: TranscriptCheckpoint,
  checkpoint?: (value: TranscriptCheckpoint) => void,
): Promise<UsageTranscriptReadResult | null> {
  if (provider !== "claude" && provider !== "codex") return null;
  let records: UsageRecord[] = [];
  const started = Date.now();
  let codexState = initialCodexTranscriptState();
  let recordBytes = 0;
  let skippedLineCount = 0,
    malformedLineCount = 0,
    lineCount = 0,
    reusedLineCount = 0,
    limited = false;
  const appendRecord = (record: UsageRecord) => {
    records.push(record);
    // Conservatively budget UTF-16 strings and fixed record/object overhead.
    recordBytes +=
      256 + 2 * (record.model.length + record.sessionId.length + (record.dedupeKey?.length ?? 0));
  };
  const consume = (line: string) => {
    const carriesUsage = mightCarryUsage(line, provider);
    if (provider === "claude") {
      if (!carriesUsage) {
        skippedLineCount++;
        return;
      }
      const record = parseClaudeTranscriptLine(line);
      if (record !== null) appendRecord(record);
      else if (isJson(line)) skippedLineCount++;
      else malformedLineCount++;
    } else {
      const carriesContext = line.includes('"turn_context"') || line.includes('"session_meta"');
      if (!carriesUsage && !carriesContext) {
        skippedLineCount++;
        return;
      }
      const record = parseCodexTranscriptLine(line, codexState);
      if (record !== null) appendRecord(record);
      else if (!isJson(line)) malformedLineCount++;
      else if (carriesUsage) skippedLineCount++;
    }
  };
  let file: NodeFSP.FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    const pathBefore = await NodeFSP.lstat(filePath);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return null;
    file = await NodeFSP.open(
      filePath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    const before = await file.stat();
    if (
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.ctimeMs !== pathBefore.ctimeMs
    )
      return null;
    if (!before.isFile() || before.size > USAGE_TRANSCRIPT_LIMITS.fileBytes) {
      return { records, skippedLineCount, malformedLineCount, limited: true, reusedLineCount };
    }

    let offset = 0;
    let prefixHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    if (
      previous &&
      previous.provider === provider &&
      previous.device === before.dev &&
      previous.inode === before.ino &&
      previous.offset <= before.size
    ) {
      // Metadata cannot prove an append: validate every old byte, without decoding JSON.
      while (offset < previous.offset) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, previous.offset - offset),
          offset,
        );
        if (bytesRead === 0) return null;
        prefixHash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
        if (Date.now() - started >= 2_000)
          return { records, skippedLineCount, malformedLineCount, limited: true, reusedLineCount };
      }
      if (prefixHash.copy().digest("hex") === previous.digest) {
        records = [...previous.records];
        recordBytes =
          previous.retainedBytes -
          2 *
            (previous.state.model.length +
              previous.state.sessionId.length +
              (previous.state.lastUsageSignature?.length ?? 0));
        codexState = { ...previous.state };
        skippedLineCount = previous.skippedLineCount;
        malformedLineCount = previous.malformedLineCount;
        lineCount = reusedLineCount = previous.lineCount;
      } else {
        offset = 0;
        prefixHash = createHash("sha256");
      }
    }
    let completeOffset = offset;
    let pending = Buffer.alloc(0),
      discarding = false;
    while (offset < before.size) {
      signal?.throwIfAborted();
      if (Date.now() - started >= 2_000) {
        limited = true;
        break;
      }
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (bytesRead === 0) return null;
      let cursor = 0;
      while (cursor < bytesRead) {
        const found = buffer.indexOf(10, cursor);
        const newline = found >= 0 && found < bytesRead ? found : -1;
        const end = newline === -1 ? bytesRead : newline;
        const segment = buffer.subarray(cursor, end);
        if (!discarding && pending.length + segment.length > USAGE_TRANSCRIPT_LIMITS.lineBytes) {
          discarding = true;
          pending = Buffer.alloc(0);
          limited = true;
          malformedLineCount++;
        }
        if (!discarding) {
          pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
        }
        if (newline !== -1) {
          if (++lineCount > USAGE_TRANSCRIPT_LIMITS.records) {
            limited = true;
            break;
          }
          if (!discarding) {
            prefixHash.update(pending).update("\n");
            consume(pending.toString("utf8"));
          }
          completeOffset = offset + newline + 1;
          pending = Buffer.alloc(0);
          discarding = false;
        }
        cursor = end + (newline === -1 ? 0 : 1);
      }
      offset += bytesRead;
      if (lineCount > USAGE_TRANSCRIPT_LIMITS.records) break;
    }
    // The checkpoint ends at the last newline. A final line can be valid JSON today
    // and receive more bytes tomorrow, so its result and parser state are provisional.
    const nextCheckpoint: TranscriptCheckpoint | undefined = limited
      ? undefined
      : {
          provider,
          device: before.dev,
          inode: before.ino,
          offset: completeOffset,
          digest: prefixHash.digest("hex"),
          state: { ...codexState },
          records: pending.length === 0 ? records : [...records],
          skippedLineCount,
          malformedLineCount,
          lineCount,
          retainedBytes:
            recordBytes +
            2 *
              (codexState.model.length +
                codexState.sessionId.length +
                (codexState.lastUsageSignature?.length ?? 0)),
        };
    if (pending.length > 0 && !limited) consume(pending.toString("utf8"));
    const after = await file.stat();
    const pathAfter = await NodeFSP.lstat(filePath);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.isSymbolicLink()
    )
      return null;
    if (nextCheckpoint) checkpoint?.(nextCheckpoint);
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    await file?.close();
  }
  return { records, skippedLineCount, malformedLineCount, limited, reusedLineCount };
}
