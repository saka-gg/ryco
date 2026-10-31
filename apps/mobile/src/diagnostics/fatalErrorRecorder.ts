/**
 * Keeps the last JavaScript errors that crashed the app, so Settings > Diagnostics can show
 * them after the next launch. expo-updates' own log keeps only startup crashes, and only while
 * over-the-air updates are on; this covers every fatal error, startup or not.
 *
 * Two doors lead here. `fatalErrorRecorderEntry.ts`, imported by `index.ts` right after the
 * polyfills, wraps React Native's global handler, which sees errors thrown outside React. React
 * hands an error thrown while rendering straight to React Native's ExceptionsManager instead,
 * so `FatalRenderErrorBoundary.tsx` at the app root records those.
 *
 * It loads at launch, so it stays tiny: the file store loads with a function-scoped `require`
 * only when an error is fatal (`mobileStartupImports.test.ts`). Messages and stacks are redacted
 * before they are written (`crashTextRedaction.ts`). Nothing leaves the device; records are
 * bounded and the Diagnostics screen can clear them.
 */
import { redactCrashText } from "./crashTextRedaction";

export interface FatalErrorRecord {
  /** ISO time of the crash. */
  readonly at: string;
  readonly message: string;
  readonly stack: string | null;
}

/** The newest records kept, and how long. */
export const FATAL_ERROR_RECORD_LIMIT = 10;
export const FATAL_ERROR_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MESSAGE_LIMIT = 1024;
const STACK_LIMIT = 4096;
/**
 * Redaction reads at most this much, so a huge message cannot hold up the crash. It only
 * shortens text, and real text not by anywhere near this much, so a path or URL cut off here
 * stays past the limits.
 */
const REDACTION_INPUT_LIMIT = 64 * 1024;

/** Where the records live: one small JSON file in the app's cache directory. */
export interface FatalErrorStore {
  readonly read: () => string | null;
  readonly write: (text: string) => void;
  readonly clear: () => void;
}

/** React Native's global error handler registry (`global.ErrorUtils`). */
export interface ErrorUtilsLike {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
}

const clip = (text: string, limit: number) => (text.length <= limit ? text : text.slice(0, limit));
const redacted = (text: string, limit: number) =>
  clip(redactCrashText(clip(text, REDACTION_INPUT_LIMIT)), limit);

function isRecord(value: unknown): value is FatalErrorRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === "string" &&
    typeof record.message === "string" &&
    (record.stack === null || typeof record.stack === "string")
  );
}

/** The stored records, newest last, without any older than seven days. Never throws. */
export function parseFatalErrorRecords(
  text: string | null,
  nowMs: number,
): ReadonlyArray<FatalErrorRecord> {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecord)
      .filter((record) => {
        const at = Date.parse(record.at);
        return Number.isFinite(at) && nowMs - at <= FATAL_ERROR_RECORD_MAX_AGE_MS;
      })
      .slice(-FATAL_ERROR_RECORD_LIMIT);
  } catch {
    return [];
  }
}

/** The file's next contents with `error` appended (redacted, bounded and capped). */
export function appendFatalErrorRecord(text: string | null, error: unknown, nowMs: number): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Unknown error";
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : null;
  const record: FatalErrorRecord = {
    at: new Date(nowMs).toISOString(),
    message: redacted(message, MESSAGE_LIMIT),
    stack: stack === null ? null : redacted(stack, STACK_LIMIT),
  };
  return JSON.stringify(
    [...parseFatalErrorRecords(text, nowMs), record].slice(-FATAL_ERROR_RECORD_LIMIT),
  );
}

/** Appends `error` to the store. Best effort: it never throws, so the crash goes on as before. */
export function recordFatalError(
  store: () => FatalErrorStore,
  error: unknown,
  nowMs: number,
): void {
  try {
    const opened = store();
    opened.write(appendFatalErrorRecord(opened.read(), error, nowMs));
  } catch {
    // Recording is best effort; the crash itself goes on as before.
  }
}

/**
 * Wraps the global error handler: a fatal error is written synchronously, then handed to the
 * previous handler (which shows the red box or ends the app). Recording never throws, so a
 * full disk or a broken file cannot change how the app fails.
 */
export function installFatalErrorRecorder(input: {
  readonly errorUtils: ErrorUtilsLike | undefined;
  readonly store: () => FatalErrorStore;
  readonly now?: () => number;
}): void {
  const { errorUtils } = input;
  if (errorUtils === undefined) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal === true) recordFatalError(input.store, error, (input.now ?? Date.now)());
    previous(error, isFatal);
  });
}

/**
 * The root error boundary's `componentDidCatch`: writes the record, then throws the same error
 * on. With no boundary above, React treats the rethrown error as uncaught: it unmounts the app
 * and reports the error to React Native as fatal (the red box, or the app ending), as it did
 * before the boundary existed. Rethrowing the same object keeps the component stack React
 * captured for it.
 */
export function recordRenderCrash(
  store: () => FatalErrorStore,
  error: unknown,
  now: () => number = Date.now,
): never {
  recordFatalError(store, error, now());
  throw error;
}
