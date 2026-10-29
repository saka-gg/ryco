import type { TimestampFormat } from "@ryco/contracts/settings";
import {
  describeSourceControlPause,
  readSourceControlPause,
  type SourceControlPause,
} from "@ryco/shared/sourceControlFailure";

import { formatShortTimestamp } from "./timestampFormat";

/**
 * Rate-limit pauses in the web app: the one wording every surface shows, and
 * the pauses source control reads ran into. One module, kept apart from
 * `sourceControlPresentation` (and its host icons), that travels with the
 * source control reads instead of adding a chunk of its own.
 */

// ── Wording ──────────────────────────────────────────────────────────

export interface SourceControlPauseText {
  readonly title: string;
  readonly detail: string;
}

/** Formats when a rate-limit pause ends ("14:32"), in the user's time format. */
export function sourceControlPauseTimeFormatter(
  timestampFormat: TimestampFormat,
): (epochMs: number) => string {
  return (epochMs) => formatShortTimestamp(new Date(epochMs).toISOString(), timestampFormat);
}

/**
 * "GitHub requests paused until 14:32", in the user's time format. Whether the
 * end is still ahead is decided when the text is made (when the read failed,
 * since surfaces memoize it on the error).
 */
export function formatSourceControlPauseText(
  pause: SourceControlPause,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): SourceControlPauseText {
  return describeSourceControlPause(pause, {
    nowMs,
    formatTime: sourceControlPauseTimeFormatter(timestampFormat),
  });
}

/** The pause wording for a failed source control read; null when it is not a rate-limit pause. */
export function formatSourceControlPause(
  error: unknown,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): SourceControlPauseText | null {
  const pause = readSourceControlPause(error);
  return pause === null ? null : formatSourceControlPauseText(pause, timestampFormat, nowMs);
}

// ── Pauses reads ran into ────────────────────────────────────────────
//
// Each until it ends, so a surface without a failed read of its own (the
// sidebar Inbox, whose rows keep showing what they last loaded) can still say
// requests are paused. One entry per read: its next outcome replaces it, so a
// read that succeeds again (the host answered) clears its pause. Only pauses
// with a known end are kept; an older server's untimed rate-limit error shows
// where it failed.

interface ObservedPause extends SourceControlPause {
  readonly retryAt: number;
}

const observed = new Map<string, ObservedPause>();
const listeners = new Set<() => void>();
let latest: ObservedPause | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
// The expiry check runs at least this often: a node whose clock runs far ahead
// can report an end past what a timer can wait for (a longer delay fires at once).
const MAX_EXPIRY_CHECK_MS = 60 * 60_000;

function publish(nowMs: number): void {
  let next: ObservedPause | null = null;
  let earliestEnd = Number.POSITIVE_INFINITY;
  for (const [key, pause] of observed) {
    if (pause.retryAt <= nowMs) {
      observed.delete(key);
      continue;
    }
    if (next === null || pause.retryAt > next.retryAt) next = pause;
    earliestEnd = Math.min(earliestEnd, pause.retryAt);
  }
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = Number.isFinite(earliestEnd)
    ? setTimeout(
        () => {
          expiryTimer = null;
          publish(Date.now());
        },
        Math.min(earliestEnd - nowMs, MAX_EXPIRY_CHECK_MS),
      )
    : null;
  if (next?.provider === latest?.provider && next?.retryAt === latest?.retryAt) return;
  latest = next;
  for (const listener of listeners) listener();
}

/** Records how one read (`readKey`) ended: its error, or null after a success. */
export function noteSourceControlReadOutcome(readKey: string, error: unknown, nowMs: number): void {
  const pause = readSourceControlPause(error);
  if (pause !== null && pause.retryAt !== null && pause.retryAt > nowMs) {
    observed.set(readKey, { provider: pause.provider, retryAt: pause.retryAt });
  } else if (!observed.delete(readKey)) {
    return;
  }
  publish(nowMs);
}

/** The running pause that ends last, or null; the same object until that changes. */
export function latestSourceControlPause(): SourceControlPause | null {
  return latest;
}

export function subscribeSourceControlPauses(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSourceControlPausesForTests(): void {
  observed.clear();
  latest = null;
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
}
