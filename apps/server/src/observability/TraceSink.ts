import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { Effect } from "effect";

import { recordResourceAttribution } from "../diagnostics/ResourceAttribution.ts";

import type { TraceRecord } from "./TraceRecord.ts";

const FLUSH_BUFFER_THRESHOLD = 32;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_RECORDS = 2_048;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const MIN_RETRY_DELAY_MS = 250;

interface BufferedTraceRecord {
  readonly line: string;
  readonly bytes: number;
  readonly priority: boolean;
}

function isPriorityRecord(record: TraceRecord): boolean {
  if (record.type === "effect-span") {
    return record.exit._tag !== "Success";
  }
  const statusCode = record.status?.code?.toUpperCase();
  return statusCode === "2" || statusCode?.includes("ERROR") === true;
}

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly maxRetryDelayMs?: number;
}

export interface TraceSinkHealth {
  readonly bufferedBytes: number;
  readonly bufferedRecords: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly droppedRecords: number;
  readonly writeFailures: number;
  readonly retryDelayMs: number;
  readonly lastWriteFailureAt: string | null;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
  health: () => TraceSinkHealth;
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const sink = new AsyncRotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    throwOnError: true,
  });

  const maxBufferedBytes = Math.max(
    0,
    Math.floor(options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES),
  );
  const maxBufferedRecords = Math.max(
    0,
    Math.floor(options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS),
  );
  const maxRetryDelayMs = Math.max(
    MIN_RETRY_DELAY_MS,
    Math.floor(options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS),
  );

  let buffer: Array<BufferedTraceRecord> = [];
  let bufferedBytes = 0;
  let droppedRecords = 0;
  let writeFailures = 0;
  let retryDelayMs = 0;
  let lastWriteFailureAt: string | null = null;
  let flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<void> | null = null;
  let closed = false;

  const clearScheduledFlush = () => {
    if (flushTimeoutId === null) {
      return;
    }

    clearTimeout(flushTimeoutId);
    flushTimeoutId = null;
  };

  const scheduleFlush = (delayMs: number) => {
    if (buffer.length === 0 || flushTimeoutId !== null) {
      return;
    }

    flushTimeoutId = setTimeout(() => {
      flushTimeoutId = null;
      void flushOnce();
    }, delayMs);
    flushTimeoutId.unref?.();
  };

  const trimBufferToBudget = () => {
    while (
      buffer.length > 0 &&
      (bufferedBytes > maxBufferedBytes || buffer.length > maxBufferedRecords)
    ) {
      const nonPriorityIndex = buffer.findIndex((record) => !record.priority);
      const [dropped] = buffer.splice(nonPriorityIndex === -1 ? 0 : nonPriorityIndex, 1);
      if (dropped !== undefined) {
        bufferedBytes -= dropped.bytes;
        droppedRecords += 1;
      }
    }
  };

  const scheduleBufferedFlush = () => {
    if (closed || buffer.length === 0) return;
    if (retryDelayMs > 0) {
      scheduleFlush(retryDelayMs);
    } else if (buffer.length >= FLUSH_BUFFER_THRESHOLD || options.batchWindowMs <= 0) {
      queueMicrotask(() => void flushOnce());
    } else {
      scheduleFlush(options.batchWindowMs);
    }
  };

  const flushOnce = async (flushOptions?: { readonly scheduleRetry?: boolean }): Promise<void> => {
    clearScheduledFlush();

    if (activeFlush) {
      await activeFlush;
      return;
    }
    if (buffer.length === 0) {
      return;
    }

    const pendingRecords = buffer;
    const pendingBytes = bufferedBytes;
    const chunk = pendingRecords.map((record) => record.line).join("");
    buffer = [];
    bufferedBytes = 0;

    const flushStartedAt = performance.now();
    const operation = sink
      .write(chunk)
      .then(() => {
        recordResourceAttribution(
          "server-trace",
          "append",
          0,
          pendingBytes,
          performance.now() - flushStartedAt,
          pendingRecords.length,
        );
        retryDelayMs = 0;
      })
      .catch(() => {
        buffer = pendingRecords.concat(buffer);
        bufferedBytes += pendingBytes;
        trimBufferToBudget();
        writeFailures += 1;
        lastWriteFailureAt = new Date().toISOString();
        retryDelayMs = Math.min(
          maxRetryDelayMs,
          retryDelayMs === 0
            ? Math.max(MIN_RETRY_DELAY_MS, options.batchWindowMs)
            : retryDelayMs * 2,
        );
      })
      .finally(() => {
        if (activeFlush === operation) {
          activeFlush = null;
        }
        if (flushOptions?.scheduleRetry !== false) {
          scheduleBufferedFlush();
        }
      });
    activeFlush = operation;
    await operation;
  };

  const closeUnsafe = async (): Promise<void> => {
    if (closed) {
      if (activeFlush) await activeFlush;
      return;
    }
    closed = true;
    clearScheduledFlush();
    if (activeFlush) {
      await activeFlush;
    }
    if (buffer.length > 0) {
      await flushOnce({ scheduleRetry: false });
    }
    await sink.close();
  };

  const flushAll = async (): Promise<void> => {
    await flushOnce();
    while (buffer.length > 0) {
      if (activeFlush !== null || retryDelayMs !== 0) break;
      await flushOnce();
    }
  };

  const flush = Effect.promise(flushAll).pipe(Effect.withTracerEnabled(false));
  const close = Effect.promise(closeUnsafe).pipe(Effect.withTracerEnabled(false));

  yield* Effect.addFinalizer(() =>
    Effect.sync(clearScheduledFlush).pipe(Effect.andThen(close), Effect.ignore),
  );

  return {
    filePath: options.filePath,
    push(record) {
      try {
        if (closed) {
          droppedRecords += 1;
          return;
        }
        const serialized = `${JSON.stringify(record)}\n`;
        const serializedBytes = Buffer.byteLength(serialized);

        if (
          serializedBytes > maxBufferedBytes ||
          maxBufferedBytes === 0 ||
          maxBufferedRecords === 0
        ) {
          droppedRecords += 1;
          return;
        }

        const bufferedRecord: BufferedTraceRecord = {
          line: serialized,
          bytes: serializedBytes,
          priority: isPriorityRecord(record),
        };
        while (
          buffer.length > 0 &&
          (bufferedBytes + serializedBytes > maxBufferedBytes ||
            buffer.length >= maxBufferedRecords)
        ) {
          const nonPriorityIndex = buffer.findIndex((candidate) => !candidate.priority);
          if (!bufferedRecord.priority && nonPriorityIndex === -1) {
            droppedRecords += 1;
            return;
          }
          const [dropped] = buffer.splice(nonPriorityIndex === -1 ? 0 : nonPriorityIndex, 1);
          if (dropped !== undefined) {
            bufferedBytes -= dropped.bytes;
            droppedRecords += 1;
          }
        }

        buffer.push(bufferedRecord);
        bufferedBytes += serializedBytes;
        if (activeFlush) {
          return;
        }
        if (retryDelayMs > 0) {
          scheduleFlush(retryDelayMs);
          return;
        }
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD || options.batchWindowMs <= 0) {
          void flushOnce();
          return;
        }
        scheduleFlush(options.batchWindowMs);
      } catch {
        droppedRecords += 1;
        return;
      }
    },
    flush,
    close: () => close,
    health: () => ({
      bufferedBytes,
      bufferedRecords: buffer.length,
      maxBufferedBytes,
      maxBufferedRecords,
      droppedRecords,
      writeFailures,
      retryDelayMs,
      lastWriteFailureAt,
    }),
  } satisfies TraceSink;
});
