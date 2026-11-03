// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@ryco/contracts";
import { REGULAR_FILE_READ_FLAGS } from "@ryco/shared/regularFile";

import { parseClaudeTranscriptLine } from "./claudeTranscript.ts";
import {
  initialCodexTranscriptState,
  parseCodexTranscriptLine,
  type CodexTranscriptState,
} from "./codexTranscript.ts";
import { usageLineMarker, type UsageRecord } from "./usageRecord.ts";

export const USAGE_TRANSCRIPT_LIMITS = {
  entries: 50_000,
  files: 10_000,
  depth: 16,
  fileBytes: 512 * 1024 * 1024,
  lineBytes: 16 * 1024 * 1024,
  records: 100_000,
} as const;

/** Read size for transcript scans: few syscalls, and one hash update per chunk. */
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
/** Concurrent lstat calls while listing one directory. */
const LISTING_STAT_CONCURRENCY = 32;
/** Directories listed at once; each keeps at most one handle and one stat batch open. */
const LISTING_DIRECTORY_CONCURRENCY = 16;

/** Codex lines that update parser state without carrying usage themselves. */
const CODEX_CONTEXT_MARKERS = ['"turn_context"', '"session_meta"', '"thread_settings_applied"'].map(
  (marker) => Buffer.from(marker),
);
/**
 * Codex rollout lines open with `{"timestamp":"…",` (newer versions add scalar
 * fields such as `"ordinal":12,`) then `"type":"<kind>","payload":{"type":"<kind>"`.
 * Only top-level scalars may precede `type`, so both kinds are the real ones,
 * and they alone decide whether the parser acts on the line: large tool-output
 * lines are skipped without searching their whole body for markers. Anything
 * else falls back to the marker search.
 */
const CODEX_ENVELOPE =
  /^\{"timestamp":"[^"\\]{0,64}",(?:"[a-z_]{1,32}":(?:-?\d{1,20}|"[^"\\]{0,64}"|true|false|null),){0,4}"type":"([a-z_]{1,64})","payload":\{"type":"([a-z_]{1,64})"/;
const CODEX_PARSED_TYPES = new Set(["session_meta", "turn_context"]);
const CODEX_PARSED_PAYLOAD_TYPES = new Set(["thread_settings_applied", "token_count"]);
/** Below this a full marker search costs less than reading the envelope. */
const CODEX_ENVELOPE_MIN_LINE_BYTES = 1024;

function codexEnvelopeIsInert(bytes: Buffer): boolean {
  if (bytes.length < CODEX_ENVELOPE_MIN_LINE_BYTES) return false;
  const match = CODEX_ENVELOPE.exec(bytes.toString("latin1", 0, 256));
  return (
    match !== null &&
    !CODEX_PARSED_TYPES.has(match[1]!) &&
    !CODEX_PARSED_PAYLOAD_TYPES.has(match[2]!)
  );
}

const USAGE_MARKERS = {
  claude: Buffer.from(usageLineMarker("claude")),
  codex: Buffer.from(usageLineMarker("codex")),
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
    count = 0,
    // Candidates seen but not stat'ed yet, so concurrent visits respect the files limit.
    pendingCandidateCount = 0;
  const directories = [{ path: root, depth: 0 }];
  const withinLimits = () =>
    count < USAGE_TRANSCRIPT_LIMITS.entries &&
    files.length + pendingCandidateCount < USAGE_TRANSCRIPT_LIMITS.files;
  // Candidate files are stat'ed in concurrent batches instead of one by one.
  const statCandidates = async (batch: readonly string[]) => {
    if (batch.length === 0) return;
    const stats = await Promise.all(
      batch.map((child) =>
        NodeFSP.lstat(child).then(
          (stat) => stat,
          () => null,
        ),
      ),
    );
    pendingCandidateCount -= batch.length;
    signal?.throwIfAborted();
    for (const [index, stat] of stats.entries()) {
      if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
        errorCount++;
        continue;
      }
      if (stat.mtimeMs >= modifiedAfterMs)
        files.push({
          path: batch[index]!,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          fingerprint: `${stat.dev}:${stat.ino}:${stat.ctimeMs}`,
        });
      else skippedEntryCount++;
    }
  };
  const visit = async (directory: { readonly path: string; readonly depth: number }) => {
    const candidates: string[] = [];
    try {
      const directoryStat = await NodeFSP.lstat(directory.path);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        errorCount++;
        return;
      }
      const entries = await NodeFSP.opendir(directory.path);
      for await (const entry of entries) {
        signal?.throwIfAborted();
        if (
          ++count >= USAGE_TRANSCRIPT_LIMITS.entries ||
          files.length + pendingCandidateCount >= USAGE_TRANSCRIPT_LIMITS.files
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
        candidates.push(child);
        pendingCandidateCount++;
        if (candidates.length >= LISTING_STAT_CONCURRENCY) {
          await statCandidates(candidates.splice(0));
        }
      }
    } catch {
      signal?.throwIfAborted();
      errorCount++;
    }
    await statCandidates(candidates.splice(0));
  };
  // Real layouts hold a few transcripts per directory, so directories are
  // visited concurrently too, with a bounded number in flight. On a failure
  // (an abort) nothing new starts, and the walk rejects once every visit in
  // flight has settled and closed its directory handle.
  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let failure: { readonly error: unknown } | undefined;
    const fail = (error: unknown) => {
      failure ??= { error };
    };
    const pump = () => {
      if (failure === undefined && signal?.aborted === true) fail(signal.reason);
      // Visits settle asynchronously, so none fails while this loop runs.
      if (failure === undefined) {
        while (active < LISTING_DIRECTORY_CONCURRENCY && directories.length > 0 && withinLimits()) {
          const directory = directories.pop()!;
          active++;
          visit(directory).then(
            () => {
              active--;
              pump();
            },
            (error: unknown) => {
              active--;
              fail(error);
              pump();
            },
          );
        }
      }
      if (active > 0) return;
      if (failure === undefined) resolve();
      else reject(failure.error);
    };
    pump();
  });
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

export interface UsageTranscriptReader {
  (
    filePath: string,
    provider: UsageProviderKind,
    signal?: AbortSignal,
  ): Promise<UsageTranscriptReadResult | null>;
  /** Drop every checkpoint, releasing the records they retain. */
  readonly clear: () => void;
}

/** Keep parser checkpoints in memory only; never persist provider transcript state. */
export function createUsageTranscriptReader(): UsageTranscriptReader {
  const checkpoints = new Map<string, TranscriptCheckpoint>();
  let retainedRecords = 0;
  let retainedBytes = 0;
  const clear = () => {
    checkpoints.clear();
    retainedRecords = 0;
    retainedBytes = 0;
  };
  const read = async (filePath: string, provider: UsageProviderKind, signal?: AbortSignal) => {
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
  return Object.assign(read, { clear });
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
  // Markers are ASCII, so a byte search matches exactly what a search of the
  // decoded line would. Almost every line has none and is never decoded.
  const usageMarker = USAGE_MARKERS[provider];
  const consume = (bytes: Buffer) => {
    if (provider === "codex" && codexEnvelopeIsInert(bytes)) {
      skippedLineCount++;
      return;
    }
    const carriesUsage = bytes.indexOf(usageMarker) !== -1;
    if (provider === "claude") {
      if (!carriesUsage) {
        skippedLineCount++;
        return;
      }
      const line = bytes.toString("utf8");
      const record = parseClaudeTranscriptLine(line);
      if (record !== null) appendRecord(record);
      else if (isJson(line)) skippedLineCount++;
      else malformedLineCount++;
    } else {
      const carriesContext = CODEX_CONTEXT_MARKERS.some((marker) => bytes.indexOf(marker) !== -1);
      if (!carriesUsage && !carriesContext) {
        skippedLineCount++;
        return;
      }
      const line = bytes.toString("utf8");
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
    file = await NodeFSP.open(filePath, REGULAR_FILE_READ_FLAGS);
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
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(TRANSCRIPT_CHUNK_BYTES, before.size)));
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
    // An unfinished line: copied pieces of earlier chunks, joined once when it ends.
    let pending: Buffer[] = [],
      pendingLength = 0,
      discarding = false;
    const takeLine = (tail: Buffer): Buffer => {
      if (pendingLength === 0) return tail;
      const line = Buffer.concat([...pending, tail], pendingLength + tail.length);
      pending = [];
      pendingLength = 0;
      return line;
    };
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
      const chunk = buffer.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(10);
      if (lastNewline !== -1) {
        // The checkpoint digest covers raw bytes through the last complete line.
        // Hashing whole chunks equals hashing line by line whenever a checkpoint
        // is kept: a discarded line or a record cap marks the read limited.
        for (const piece of pending) prefixHash.update(piece);
        prefixHash.update(chunk.subarray(0, lastNewline + 1));
      }
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = cursor <= lastNewline ? chunk.indexOf(10, cursor) : -1;
        const end = newline === -1 ? bytesRead : newline;
        const segment = chunk.subarray(cursor, end);
        if (!discarding && pendingLength + segment.length > USAGE_TRANSCRIPT_LIMITS.lineBytes) {
          discarding = true;
          pending = [];
          pendingLength = 0;
          limited = true;
          malformedLineCount++;
        }
        if (newline === -1) {
          if (!discarding) {
            // The read buffer is reused, so an unfinished line must be copied.
            pending.push(Buffer.from(segment));
            pendingLength += segment.length;
          }
          break;
        }
        lineCount++;
        if (records.length >= USAGE_TRANSCRIPT_LIMITS.records) {
          limited = true;
          break;
        }
        if (!discarding) consume(takeLine(segment));
        completeOffset = offset + newline + 1;
        pending = [];
        pendingLength = 0;
        discarding = false;
        cursor = newline + 1;
      }
      offset += bytesRead;
      if (records.length >= USAGE_TRANSCRIPT_LIMITS.records) {
        if (offset < before.size || pendingLength > 0) limited = true;
        break;
      }
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
          records: pendingLength === 0 ? records : [...records],
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
    if (pendingLength > 0 && !limited) consume(takeLine(Buffer.alloc(0)));
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
