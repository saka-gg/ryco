import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { Effect, Logger, References, Layer, type LogLevel, type Scope } from "effect";

import { ServerConfig } from "./config.ts";

/** Same rotation as the desktop shell's own log files. */
export const SERVER_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SERVER_LOG_FILE_MAX_FILES = 3;
const SERVER_LOG_BATCH_WINDOW_MS = 250;
/** Lines that make a batch worth writing before its window ends. */
const SERVER_LOG_FLUSH_LINES = 64;
/** Buffered plus in-flight characters before new lines are dropped (and counted). */
const SERVER_LOG_MAX_PENDING_CHARS = 4 * 1024 * 1024;

export interface ServerLogFileLoggerOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxPendingChars?: number;
}

const isUrgentLevel = (level: LogLevel.LogLevel) => level === "Error" || level === "Fatal";

/**
 * Writes logfmt lines (one per record, causes included) to a rotating file
 * the server owns. Lines are batched (one `writev` per window on a held
 * handle; errors are written at once) and drained when the scope closes.
 * Never fails: a write error loses that batch, never the log call.
 */
export const makeServerLogFileLogger = (
  options: ServerLogFileLoggerOptions,
): Effect.Effect<Logger.Logger<unknown, void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sink = new AsyncRotatingFileSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes ?? SERVER_LOG_FILE_MAX_BYTES,
      maxFiles: options.maxFiles ?? SERVER_LOG_FILE_MAX_FILES,
    });
    const batchWindowMs = options.batchWindowMs ?? SERVER_LOG_BATCH_WINDOW_MS;
    const maxPendingChars = options.maxPendingChars ?? SERVER_LOG_MAX_PENDING_CHARS;

    let buffer: Array<string> = [];
    let bufferedChars = 0;
    let inFlightChars = 0;
    let dropped = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const flush = (): Promise<void> => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (dropped > 0) {
        buffer.push(
          `timestamp=${new Date().toISOString()} level=WARN message="server log dropped ${dropped} lines while writes were backed up"\n`,
        );
        dropped = 0;
      }
      if (buffer.length === 0) return sink.flush();
      const chunk = buffer.join("");
      const chars = bufferedChars;
      buffer = [];
      bufferedChars = 0;
      inFlightChars += chars;
      // The sink serializes writes, so batches land in order.
      return sink.write(chunk).finally(() => {
        inFlightChars -= chars;
      });
    };

    const scheduleFlush = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, batchWindowMs);
      timer.unref?.();
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true;
        await flush();
        await sink.close();
      }),
    );

    return Logger.make((logOptions) => {
      if (closed) return;
      const line = `${Logger.formatLogFmt.log(logOptions)}\n`;
      if (bufferedChars + inFlightChars + line.length > maxPendingChars && bufferedChars > 0) {
        dropped += 1;
        return;
      }
      buffer.push(line);
      bufferedChars += line.length;
      if (isUrgentLevel(logOptions.logLevel) || buffer.length >= SERVER_LOG_FLUSH_LINES) {
        void flush();
      } else {
        scheduleFlush();
      }
    });
  });

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggers: Array<Logger.Logger<unknown, unknown>> = [
    Logger.consolePretty(),
    Logger.tracerLogger,
  ];
  // The desktop backend keeps its own log, which Diagnostics tails, so the
  // shell has no need to copy stdout once the backend serves.
  if (config.mode === "desktop") {
    loggers.push(yield* makeServerLogFileLogger({ filePath: config.serverLogPath }));
  }
  const loggerLayer = Logger.layer(loggers, {
    mergeWithExisting: false,
  });

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
