/**
 * What the server's forge read caches do while a forge is rate limiting.
 *
 * - Last good: a successful read is remembered for up to an hour. When a later read of it
 *   fails with a rate limit (the forge said so, or Ryco's pause refused the read), a background
 *   reader (sidebar badges, row glyphs, workspace sweeps) gets that last good value instead of
 *   the error. It is a copy marked with the pause's end (`pausedUntilOf`): such data is never
 *   cached as fresh, never feeds link-state writes and never becomes last good itself. An
 *   interactive reader (what a user opened) gets the typed error, so the surface it reads for
 *   can say the forge is paused.
 * - Holds: a rate-limited answer the forge gave itself is kept until the pause ends, so every
 *   reader of the same read shares it instead of asking again. An invalidation (the periodic
 *   remote refresh, git actions) keeps it while the forge's background reads are still paused.
 *   A refusal by Ryco's own pause is never held: it reached no forge.
 *
 * On the boot path (the caches are built at startup), so it stays small.
 */
import { Effect } from "effect";
import { readSourceControlFailure } from "@ryco/shared/sourceControlFailure";

import { ProcessLaneRef } from "../processGovernor.ts";
import { isForgeRequestRefusedWhilePaused } from "./forgeRequestPaused.ts";

/** Data older than GitHub's primary rate-limit window is not served. */
export const LAST_GOOD_MAX_AGE_MS = 60 * 60_000;
/** How long a rate-limited answer that named no time is held. */
export const DEFAULT_PAUSE_HOLD_MS = 30_000;
/** The shortest hold: as long as a failed listing was kept before pauses existed. */
export const MIN_PAUSE_HOLD_MS = 10_000;
/** The longest hold (the cap of the guessed pause); the forge is asked again after it. */
export const MAX_PAUSE_HOLD_MS = 15 * 60_000;

/** How long to hold until `retryAt`, clamped to [minMs, MAX_PAUSE_HOLD_MS]. */
export function pauseHoldMs(retryAt: number | null, nowMs: number, minMs = MIN_PAUSE_HOLD_MS) {
  if (retryAt === null) return Math.max(DEFAULT_PAUSE_HOLD_MS, minMs);
  return Math.min(Math.max(retryAt - nowMs, minMs), MAX_PAUSE_HOLD_MS);
}

/**
 * The hold end for a failed forge read: when the forge itself answered "rate limited", now
 * plus the hold; null for a refusal by Ryco's pause and for every other failure.
 */
export function heldUntil(error: unknown, nowMs: number): number | null {
  const failure = readSourceControlFailure(error);
  if (failure?.reason !== "rate-limited" || isForgeRequestRefusedWhilePaused(error)) return null;
  return nowMs + pauseHoldMs(failure.retryAt, nowMs);
}

const pausedUntilByValue = new WeakMap<object, number>();

/** A copy of `value` marked as served while its forge is paused until `pausedUntilMs`. */
export function markServedWhilePaused<V extends object>(value: V, pausedUntilMs: number): V {
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as V;
  pausedUntilByValue.set(copy, pausedUntilMs);
  return copy;
}

/** The pause end `value` was served under, or null for a value read from the forge. */
export function pausedUntilOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  return pausedUntilByValue.get(value) ?? null;
}

export interface LastGood<V extends object> {
  readonly remember: (key: string, value: V, nowMs: number) => void;
  /**
   * For a failed read of `key`: the last good value, marked, when the failure is a rate limit,
   * the reader is in the background lane and the value is at most an hour old; else the error.
   */
  readonly serve: <E>(key: string, error: E, nowMs: number) => Effect.Effect<V, E>;
}

/**
 * Last good values by key: the most recently remembered `capacity` ones, none older than
 * `LAST_GOOD_MAX_AGE_MS`. `mark` marks a served value (and, for a listing, its rows).
 */
export function makeLastGood<V extends object>(
  capacity: number,
  mark: (value: V, pausedUntilMs: number) => V = markServedWhilePaused,
): LastGood<V> {
  // Insertion order is remember order, so the oldest entries come first.
  const entries = new Map<string, { readonly value: V; readonly atMs: number }>();
  return {
    remember: (key, value, nowMs) => {
      entries.delete(key);
      entries.set(key, { value, atMs: nowMs });
      for (const [oldestKey, oldest] of entries) {
        if (entries.size <= capacity && nowMs - oldest.atMs <= LAST_GOOD_MAX_AGE_MS) break;
        entries.delete(oldestKey);
      }
    },
    serve: (key, error, nowMs) =>
      Effect.flatMap(ProcessLaneRef, (lane) => {
        const failure = readSourceControlFailure(error);
        const entry = entries.get(key);
        if (failure?.reason !== "rate-limited" || lane !== "background" || entry === undefined) {
          return Effect.fail(error);
        }
        if (nowMs - entry.atMs > LAST_GOOD_MAX_AGE_MS) {
          entries.delete(key);
          return Effect.fail(error);
        }
        return Effect.succeed(mark(entry.value, failure.retryAt ?? nowMs + DEFAULT_PAUSE_HOLD_MS));
      }),
  };
}
