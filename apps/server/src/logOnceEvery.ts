/**
 * Logging for failures that repeat in retry and polling loops: the first
 * occurrence of a key with its full cause, then at most one short
 * "repeated N times" summary per window while the condition persists.
 *
 * @module logOnceEvery
 */
import { LogOnceEveryLimiter } from "@ryco/shared/logOnceEvery";
import { Cause, Clock, Duration, Effect } from "effect";

/** Default spacing between lines for one key. */
export const DEFAULT_LOG_ONCE_EVERY_WINDOW = Duration.minutes(5);
const BRIEF_CAUSE_MAX_CHARS = 240;

export type LogOnceEveryLevel = "Debug" | "Info" | "Warn" | "Error";

export interface LogOnceEveryOptions {
  /** Identity of the repeating condition, e.g. `vcs.remote-refresh:${cwd}`. */
  readonly key: string;
  readonly message: string;
  /** Default `Warn`. */
  readonly level?: LogOnceEveryLevel | undefined;
  /**
   * Minimum spacing between lines for `key`. Default 5 minutes. A loop must
   * pass a window longer than its own retry spacing (backoff included): a key
   * quiet for a whole window starts a new burst, logged in full again.
   */
  readonly window?: Duration.Input | undefined;
  /** Context written on every line, summaries included. */
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The failure (an error or a `Cause`). Written in full on the first line of
   * a burst; summaries carry only its first line.
   */
  readonly cause?: unknown;
}

// One limiter per process, with the shared default key budget.
const processLimiter = new LogOnceEveryLimiter();

/** First line of a failure, bounded: enough to tell bursts apart in a summary. */
export function briefCause(cause: unknown): string {
  const failure = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  const text =
    failure instanceof Error
      ? `${failure.name}: ${failure.message}`
      : typeof failure === "string"
        ? failure
        : String(failure);
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > BRIEF_CAUSE_MAX_CHARS
    ? `${firstLine.slice(0, BRIEF_CAUSE_MAX_CHARS)}…`
    : firstLine;
}

/** Shared by {@link logOnceEvery}; exported for tests that need a fresh limiter. */
export const makeLogOnceEvery =
  (limiter: LogOnceEveryLimiter) =>
  (options: LogOnceEveryOptions): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) => {
      const windowMs = Duration.toMillis(options.window ?? DEFAULT_LOG_ONCE_EVERY_WINDOW);
      const decision = limiter.admit(options.key, windowMs, nowMs);
      if (decision.kind === "skip") return Effect.void;
      const log = Effect.logWithLevel(options.level ?? "Warn");
      const fields = options.fields ?? {};
      if (decision.kind === "summary") {
        return log(
          `${options.message} (repeated ${decision.repeats} times since ${new Date(decision.sinceMs).toISOString()})`,
          {
            ...fields,
            repeated: decision.repeats,
            ...(options.cause === undefined ? {} : { lastCause: briefCause(options.cause) }),
          },
        );
      }
      const lineFields: Record<string, unknown> =
        decision.unreportedRepeats > 0
          ? { ...fields, earlierRepeats: decision.unreportedRepeats }
          : { ...fields };
      // A Cause goes to the logger's cause slot (rendered with its stack);
      // a plain error stays a field, as call sites logged it before.
      const cause = Cause.isCause(options.cause) ? options.cause : undefined;
      if (options.cause !== undefined && cause === undefined) lineFields.cause = options.cause;
      const args: Array<unknown> = [options.message];
      if (Object.keys(lineFields).length > 0) args.push(lineFields);
      if (cause !== undefined) args.push(cause);
      return log(...args);
    });

/**
 * Logs `options.message` the first time `options.key` occurs, then at most
 * one "repeated N times" summary per window while it keeps occurring.
 * Process-wide: one key means one condition across all callers.
 */
export const logOnceEvery = makeLogOnceEvery(processLimiter);

/**
 * `Effect.ignoreCause({ log: true })` for retry and polling loops: the
 * failure is ignored and logged through {@link logOnceEvery}. Interruptions
 * are ignored without a log line. Default level `Info`, matching
 * `ignoreCause`.
 */
export const ignoreCauseLogOnceEvery =
  (options: Omit<LogOnceEveryOptions, "cause">) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    Effect.matchCauseEffect(self, {
      onSuccess: () => Effect.void,
      onFailure: (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : logOnceEvery({ ...options, level: options.level ?? "Info", cause }),
    });
