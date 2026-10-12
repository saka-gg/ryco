/**
 * Rate limiting for log lines that repeat in retry and polling loops.
 *
 * The first occurrence of a key is logged in full (with its cause). Further
 * occurrences inside the window are counted, not logged; the first one after
 * the window becomes a single "repeated N times" summary. A key that went
 * quiet for a whole window starts a new burst and is logged in full again.
 *
 * Framework-free and synchronous so the server (Effect) and the desktop shell
 * can wrap it in their own logging.
 */

export type LogOnceEveryDecision =
  /** Log in full. `unreportedRepeats` are skipped occurrences of an earlier burst. */
  | { readonly kind: "log"; readonly unreportedRepeats: number }
  /** Log a short summary: `repeats` occurrences (this one included) since `sinceMs`. */
  | { readonly kind: "summary"; readonly repeats: number; readonly sinceMs: number }
  | { readonly kind: "skip" };

export interface LogOnceEveryLimiterOptions {
  /** Keys tracked at once; the least recently seen key is forgotten first. */
  readonly maxKeys?: number;
}

interface LogOnceEveryEntry {
  /** When the last line (full or summary) for the key was logged. */
  windowStartMs: number;
  lastSeenMs: number;
  skipped: number;
}

const DEFAULT_MAX_KEYS = 1_024;
const SKIP: LogOnceEveryDecision = { kind: "skip" };
const LOG: LogOnceEveryDecision = { kind: "log", unreportedRepeats: 0 };

export class LogOnceEveryLimiter {
  private readonly entries = new Map<string, LogOnceEveryEntry>();
  private readonly maxKeys: number;

  constructor(options?: LogOnceEveryLimiterOptions) {
    this.maxKeys = Math.max(1, Math.floor(options?.maxKeys ?? DEFAULT_MAX_KEYS));
  }

  /** Decides what to log for one occurrence of `key` at `nowMs`. */
  admit(key: string, windowMs: number, nowMs: number): LogOnceEveryDecision {
    const entry = this.entries.get(key);
    // Re-inserting keeps the map ordered by last use, oldest first.
    this.entries.delete(key);
    if (
      entry !== undefined &&
      nowMs >= entry.windowStartMs &&
      nowMs - entry.windowStartMs < windowMs
    ) {
      entry.skipped += 1;
      entry.lastSeenMs = nowMs;
      this.entries.set(key, entry);
      return SKIP;
    }

    this.entries.set(key, { windowStartMs: nowMs, lastSeenMs: nowMs, skipped: 0 });
    if (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    if (entry === undefined || entry.skipped === 0) return LOG;
    // Quiet for a whole window: a new burst whose cause may differ.
    if (nowMs - entry.lastSeenMs >= windowMs || nowMs < entry.windowStartMs) {
      return { kind: "log", unreportedRepeats: entry.skipped };
    }
    return { kind: "summary", repeats: entry.skipped + 1, sinceMs: entry.windowStartMs };
  }

  /** Keys currently tracked. */
  get size(): number {
    return this.entries.size;
  }
}
