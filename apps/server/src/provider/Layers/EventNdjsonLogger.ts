/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 *
 * The write path is synchronous and span-free: a mode check, a `Map` lookup,
 * one `JSON.stringify` and an array push. Records are buffered per thread and
 * flushed every `batchWindowMs` as one `writev` on a held file handle.
 * Consecutive streaming deltas of one content stream are coalesced into a
 * single `delta-run` record. Writers idle for `idleWriterTtlMs` are flushed,
 * closed and evicted, and `close()` drains every writer (the owning layer
 * calls it on shutdown).
 */
import fs from "node:fs";
import path from "node:path";

import type { ProviderEventLogMode, ThreadId } from "@ryco/contracts";
import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { Effect } from "effect";

import { recordResourceAttribution } from "../../diagnostics/ResourceAttribution.ts";
import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { increment, providerEventLogRecordsDroppedTotal } from "../../observability/Metrics.ts";
import {
  type EventNdjsonStream,
  extractProviderEventDelta,
  formatProviderEventLogLine,
  PROVIDER_EVENT_LOG_FILE_PATTERN,
  PROVIDER_EVENT_LOG_STRING_CAP,
  providerEventDeltaRunRecord,
  providerEventLogFileName,
  providerEventLogStreamLabel,
  serializeProviderEventLogRecord,
  shouldWriteProviderEventRecord,
} from "../providerEventLogRecords.ts";

export type { EventNdjsonStream } from "../providerEventLogRecords.ts";

/**
 * Age-based retention for the event log directory. Files that have not been
 * written for this long belong to threads nobody is debugging anymore;
 * rotation alone never deletes them, so without this sweep the directory
 * grows without bound (observed: 11 GB across 450+ threads).
 */
export const DEFAULT_EVENT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface LogDirectoryRetention {
  /** Files whose mtime is older than this are removed. */
  readonly maxAgeMs?: number;
  /** After the age pass, the oldest files are removed until the directory fits. */
  readonly maxTotalBytes?: number;
  /** Which entries the sweep owns; everything else is never touched. */
  readonly filePattern?: RegExp;
  readonly now?: number;
}

/**
 * Best-effort retention for a log directory: removes matching files older
 * than `maxAgeMs`, then the oldest remaining ones until the total size fits
 * `maxTotalBytes`. Returns the number of files removed. Never fails:
 * unreadable directories or races with rotation are downgraded to a warning /
 * skipped file.
 */
export const sweepLogDirectory = Effect.fn("sweepLogDirectory")(function* (
  directory: string,
  options?: LogDirectoryRetention,
): Effect.fn.Return<number> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_EVENT_LOG_RETENTION_MS;
  const maxTotalBytes = options?.maxTotalBytes ?? Number.POSITIVE_INFINITY;
  const filePattern = options?.filePattern ?? PROVIDER_EVENT_LOG_FILE_PATTERN;
  const cutoffMs = (options?.now ?? Date.now()) - maxAgeMs;
  const removed = yield* Effect.tryPromise(async () => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const retained: Array<{ readonly filePath: string; readonly mtimeMs: number; size: number }> =
      [];
    let count = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !filePattern.test(entry.name)) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs < cutoffMs) {
          await fs.promises.unlink(filePath);
          count += 1;
        } else {
          retained.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size });
          totalBytes += stats.size;
        }
      } catch {
        // Raced with rotation or a concurrent delete; skip the file.
      }
    }
    if (totalBytes > maxTotalBytes) {
      retained.sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const file of retained) {
        if (totalBytes <= maxTotalBytes) break;
        try {
          await fs.promises.unlink(file.filePath);
          totalBytes -= file.size;
          count += 1;
        } catch {
          // Raced with rotation or a concurrent delete; skip the file.
        }
      }
    }
    return count;
  }).pipe(
    Effect.catch((error) =>
      logWarning("failed to sweep log directory", { directory, error }).pipe(Effect.as(0)),
    ),
  );
  if (removed > 0) {
    yield* Effect.logInfo("swept log directory", { directory, removed }).pipe(
      Effect.annotateLogs({ scope: LOG_SCOPE }),
    );
  }
  return removed;
});

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
// Rotation depth is per thread file, so the effective cap is
// `maxBytes * maxFiles * threads` (the directory budget sweep bounds the
// total). Keep the depth shallow: these are best-effort observability logs.
const DEFAULT_MAX_FILES = 3;
const DEFAULT_BATCH_WINDOW_MS = 200;
const DEFAULT_MAX_QUEUE_SIZE = 2_048;
// Queue budgets count UTF-16 code units of formatted lines (≈ bytes for the
// mostly-ASCII JSON written here) so they never rescan a line.
const DEFAULT_MAX_QUEUE_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_QUEUE_CHARS = 32 * 1024 * 1024;
const DEFAULT_IDLE_WRITER_TTL_MS = 2 * 60 * 1000;
/** A delta run open this long is written at the next flush even if its stream continues. */
const DELTA_RUN_MAX_AGE_MS = 1_000;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  /** Buffered records per thread before new records are dropped (and counted). */
  readonly maxQueueSize?: number;
  /** Buffered characters per thread before new records are dropped (and counted). */
  readonly maxQueueChars?: number;
  /** Buffered characters across every thread of this stream. */
  readonly maxTotalQueueChars?: number;
  /** Detail level, read on every write so a settings change applies at once. Defaults to `full`. */
  readonly mode?: () => ProviderEventLogMode;
  /** Gzip rotated backups. */
  readonly compressRotatedFiles?: boolean;
  /** Writers without records for this long are flushed, closed and evicted. */
  readonly idleWriterTtlMs?: number;
}

type DropReason = "queue_closed" | "queue_full";

interface DeltaRun {
  readonly key: string;
  readonly first: unknown;
  readonly firstAtMs: number;
  lastAtMs: number;
  count: number;
  chars: number;
  readonly parts: Array<string>;
}

interface ThreadWriter {
  readonly filePath: string;
  readonly sink: AsyncRotatingFileSink;
  readonly buffer: Array<string>;
  bufferedChars: number;
  activeChars: number;
  activeRecords: number;
  activeFlush: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  run: DeltaRun | undefined;
  lastWriteAtMs: number;
  closed: boolean;
  /**
   * Close of the evicted writer this one replaced. Its first batch waits for
   * it, so this sink never rotates while the old one still compresses a
   * backup of the same file.
   */
  predecessor: Promise<void> | undefined;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

const normalizePositiveInt = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

const unrefTimer = (timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) => {
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
};

export const makeEventNdjsonLogger = Effect.fn("makeEventNdjsonLogger")(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const stream = options.stream;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxQueueSize = normalizePositiveInt(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
  const maxQueueChars = normalizePositiveInt(options.maxQueueChars, DEFAULT_MAX_QUEUE_CHARS);
  const maxTotalQueueChars = normalizePositiveInt(
    options.maxTotalQueueChars,
    DEFAULT_MAX_TOTAL_QUEUE_CHARS,
  );
  const idleWriterTtlMs = normalizePositiveInt(options.idleWriterTtlMs, DEFAULT_IDLE_WRITER_TTL_MS);
  const getMode = options.mode ?? (() => "full" as const);
  const streamLabel = providerEventLogStreamLabel(stream);
  const attributionComponent = `provider-${stream}`;
  const directory = path.dirname(filePath);

  const directoryReady = yield* Effect.sync(() => {
    try {
      fs.mkdirSync(directory, { recursive: true });
      return true;
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (directoryReady !== true) {
    yield* logWarning("failed to create provider event log directory", {
      filePath,
      error: directoryReady.error,
    });
    return undefined;
  }

  const services = yield* Effect.context();
  const runDetached = (effect: Effect.Effect<void>) => {
    Effect.runForkWith(services)(effect);
  };
  const recordDropped = (reason: DropReason) =>
    increment(providerEventLogRecordsDroppedTotal, {
      stream,
      reason,
      maxQueueSize,
    });

  const writers = new Map<string, ThreadWriter>();
  // Evicted writers whose close (final flush, backup compression) is in flight.
  const closingWriters = new Map<string, Promise<void>>();
  const failedSegments = new Set<string>();
  let totalQueuedChars = 0;
  let evictionTimer: ReturnType<typeof setInterval> | undefined;
  // Set by `close()`: later records are dropped instead of reopening files
  // nobody will close again.
  let loggerClosed = false;

  const createWriter = (threadSegment: string): ThreadWriter | undefined => {
    const writerPath = path.join(directory, providerEventLogFileName(threadSegment, stream));
    let sink: AsyncRotatingFileSink;
    try {
      sink = new AsyncRotatingFileSink({
        filePath: writerPath,
        maxBytes,
        maxFiles,
        throwOnError: true,
        compressRotatedFiles: options.compressRotatedFiles ?? false,
      });
    } catch (error) {
      failedSegments.add(threadSegment);
      runDetached(
        logWarning("failed to initialize provider thread log file", {
          filePath: writerPath,
          error,
        }),
      );
      return undefined;
    }
    return {
      filePath: writerPath,
      sink,
      buffer: [],
      bufferedChars: 0,
      activeChars: 0,
      activeRecords: 0,
      activeFlush: undefined,
      timer: undefined,
      run: undefined,
      lastWriteAtMs: Date.now(),
      closed: false,
      predecessor: closingWriters.get(threadSegment),
    };
  };

  const resolveWriter = (threadSegment: string): ThreadWriter | undefined => {
    const existing = writers.get(threadSegment);
    if (existing !== undefined || failedSegments.has(threadSegment)) {
      return existing;
    }
    const writer = createWriter(threadSegment);
    if (writer !== undefined) {
      writers.set(threadSegment, writer);
      startEvictionTimer();
    }
    return writer;
  };

  const scheduleFlush = (writer: ThreadWriter) => {
    if (writer.timer !== undefined || writer.closed) {
      return;
    }
    writer.timer = setTimeout(() => {
      writer.timer = undefined;
      void flushWriter(writer, false);
    }, batchWindowMs);
    unrefTimer(writer.timer);
  };

  const enqueueLine = (writer: ThreadWriter, line: string): DropReason | undefined => {
    if (writer.closed) {
      return "queue_closed";
    }
    const queuedRecords = writer.buffer.length + writer.activeRecords;
    if (queuedRecords >= maxQueueSize) {
      return "queue_full";
    }
    // A single line larger than a budget still goes through an empty queue.
    if (
      queuedRecords > 0 &&
      (writer.bufferedChars + writer.activeChars + line.length > maxQueueChars ||
        totalQueuedChars + line.length > maxTotalQueueChars)
    ) {
      return "queue_full";
    }
    writer.buffer.push(line);
    writer.bufferedChars += line.length;
    totalQueuedChars += line.length;
    scheduleFlush(writer);
    return undefined;
  };

  const serialize = (record: unknown): string | undefined => {
    try {
      return serializeProviderEventLogRecord(stream, record);
    } catch (error) {
      runDetached(logWarning("failed to serialize provider event log record", { error }));
      return undefined;
    }
  };

  const enqueueRecord = (
    writer: ThreadWriter,
    record: unknown,
    observedAtMs: number,
  ): DropReason | undefined => {
    const json = serialize(record);
    return json === undefined
      ? undefined
      : enqueueLine(writer, formatProviderEventLogLine(streamLabel, observedAtMs, json));
  };

  /** Moves the open delta run (if any) into the write buffer. */
  const closeRun = (writer: ThreadWriter): DropReason | undefined => {
    const run = writer.run;
    if (run === undefined) {
      return undefined;
    }
    writer.run = undefined;
    return enqueueRecord(
      writer,
      providerEventDeltaRunRecord(stream, {
        first: run.first,
        firstAtMs: run.firstAtMs,
        lastAtMs: run.lastAtMs,
        count: run.count,
        text: run.parts.join(""),
      }),
      run.firstAtMs,
    );
  };

  const appendDelta = (
    writer: ThreadWriter,
    record: unknown,
    key: string,
    text: string,
    nowMs: number,
  ): DropReason | undefined => {
    let dropped: DropReason | undefined;
    const open = writer.run;
    if (
      open !== undefined &&
      (open.key !== key || open.chars + text.length > PROVIDER_EVENT_LOG_STRING_CAP)
    ) {
      dropped = closeRun(writer);
    }
    const run = (writer.run ??= {
      key,
      first: record,
      firstAtMs: nowMs,
      lastAtMs: nowMs,
      count: 0,
      chars: 0,
      parts: [],
    });
    run.parts.push(text);
    run.count += 1;
    run.chars += text.length;
    run.lastAtMs = nowMs;
    scheduleFlush(writer);
    return dropped;
  };

  const writeRecord = (record: unknown, threadId: ThreadId | null): DropReason | undefined => {
    const mode = getMode();
    if (!shouldWriteProviderEventRecord(mode, stream, record)) {
      return undefined;
    }
    if (loggerClosed) {
      return "queue_closed";
    }
    const writer = resolveWriter(resolveThreadSegment(threadId));
    if (writer === undefined) {
      return undefined;
    }
    if (writer.closed) {
      return "queue_closed";
    }
    const nowMs = Date.now();
    writer.lastWriteAtMs = nowMs;
    if (mode === "full") {
      const delta = extractProviderEventDelta(stream, record);
      if (delta !== undefined) {
        return appendDelta(writer, record, delta.key, delta.text, nowMs);
      }
    }
    const droppedRun = closeRun(writer);
    return enqueueRecord(writer, record, nowMs) ?? droppedRun;
  };

  const flushWriter = (writer: ThreadWriter, closing: boolean): Promise<void> => {
    if (writer.timer !== undefined) {
      clearTimeout(writer.timer);
      writer.timer = undefined;
    }
    if (
      writer.run !== undefined &&
      (closing || Date.now() - writer.run.firstAtMs >= DELTA_RUN_MAX_AGE_MS)
    ) {
      const dropped = closeRun(writer);
      if (dropped !== undefined) {
        runDetached(recordDropped(dropped));
      }
    }
    if (writer.activeFlush) {
      return writer.activeFlush;
    }
    if (writer.buffer.length === 0) {
      if (writer.run !== undefined) {
        scheduleFlush(writer);
      }
      return writer.sink.flush();
    }

    const lines = writer.buffer.splice(0, writer.buffer.length);
    const chars = writer.bufferedChars;
    writer.bufferedChars = 0;
    writer.activeChars = chars;
    writer.activeRecords = lines.length;
    const predecessor = writer.predecessor;
    writer.predecessor = undefined;
    const startedAt = performance.now();
    const operation = (
      predecessor === undefined
        ? writer.sink.writeBatch(lines)
        : predecessor.then(() => writer.sink.writeBatch(lines))
    )
      .then(
        (bytes) => {
          recordResourceAttribution(
            attributionComponent,
            "append",
            0,
            bytes,
            performance.now() - startedAt,
            lines.length,
          );
        },
        (error: unknown) => {
          runDetached(
            logWarning("provider event log batch flush failed", {
              filePath: writer.filePath,
              error,
            }),
          );
        },
      )
      .finally(() => {
        totalQueuedChars -= chars;
        writer.activeChars = 0;
        writer.activeRecords = 0;
        writer.activeFlush = undefined;
        if (writer.buffer.length > 0 || writer.run !== undefined) {
          scheduleFlush(writer);
        }
      });
    writer.activeFlush = operation;
    return operation;
  };

  const closeWriter = async (writer: ThreadWriter): Promise<void> => {
    try {
      await flushWriter(writer, true);
      // A delta run opened while that flush was in flight; once `closed` is
      // set it could no longer be enqueued.
      const droppedRun = closeRun(writer);
      if (droppedRun !== undefined) {
        runDetached(recordDropped(droppedRun));
      }
      writer.closed = true;
      // A batch enqueued while the previous flush was in flight.
      await flushWriter(writer, true);
      // A replacement that never wrote a batch still finishes after the
      // writer it replaced, so a later one (or `close()`) waiting on it waits
      // for the whole chain.
      const predecessor = writer.predecessor;
      writer.predecessor = undefined;
      await predecessor;
      await writer.sink.close();
    } catch (error) {
      runDetached(
        logWarning("provider event log close failed", {
          filePath: writer.filePath,
          error,
        }),
      );
    }
  };

  const evictIdleWriters = () => {
    const cutoffMs = Date.now() - idleWriterTtlMs;
    for (const [segment, writer] of writers) {
      if (
        writer.lastWriteAtMs <= cutoffMs &&
        writer.buffer.length === 0 &&
        writer.run === undefined &&
        writer.activeFlush === undefined
      ) {
        writers.delete(segment);
        const closing: Promise<void> = closeWriter(writer).finally(() => {
          if (closingWriters.get(segment) === closing) closingWriters.delete(segment);
        });
        closingWriters.set(segment, closing);
      }
    }
    if (writers.size === 0) {
      stopEvictionTimer();
    }
  };

  function startEvictionTimer() {
    if (evictionTimer !== undefined) {
      return;
    }
    evictionTimer = setInterval(evictIdleWriters, Math.max(250, Math.floor(idleWriterTtlMs / 2)));
    unrefTimer(evictionTimer);
  }

  function stopEvictionTimer() {
    if (evictionTimer !== undefined) {
      clearInterval(evictionTimer);
      evictionTimer = undefined;
    }
  }

  // Never fails: a record the policy cannot inspect is dropped with a warning
  // rather than failing the provider event path that logs it.
  const write = (event: unknown, threadId: ThreadId | null): Effect.Effect<void> =>
    Effect.suspend(() => {
      let dropped: DropReason | undefined;
      try {
        dropped = writeRecord(event, threadId);
      } catch (error) {
        return logWarning("provider event log enqueue failed", { error });
      }
      return dropped === undefined ? Effect.void : recordDropped(dropped);
    });

  const close = (): Effect.Effect<void> =>
    Effect.promise(async () => {
      loggerClosed = true;
      const current = [...writers.values()];
      writers.clear();
      failedSegments.clear();
      stopEvictionTimer();
      await Promise.all([...current.map(closeWriter), ...closingWriters.values()]);
    });

  return {
    filePath,
    write,
    close,
  } satisfies EventNdjsonLogger;
});
