/**
 * Random spread for retry waits. Without it every client of a machine that
 * restarts or updates (the Mac app, the phone, each browser tab) retries at the
 * same moments of the same doubling schedule.
 *
 * A wait is spread by up to {@link RETRY_JITTER_RATIO} either way. The spread
 * is fixed per client and retry: the same retry of the same schedule gets the
 * same wait on every call, so a countdown the interface shows and the wait the
 * schedule takes agree, while two clients spread the same retry differently.
 */
export const RETRY_JITTER_RATIO = 0.25;

let clientSeed = Math.random();
let jitterEnabled = true;

/** A value in [0, 1) that depends only on the client seed and its inputs. */
function spreadUnit(retryIndex: number, schedule: string): number {
  let hash = Math.floor(clientSeed * 0x7fffffff) ^ Math.imul(retryIndex + 1, 0x9e3779b1);
  for (let index = 0; index < schedule.length; index += 1) {
    hash = Math.imul(hash ^ schedule.charCodeAt(index), 0x01000193);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d);
  hash ^= hash >>> 12;
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * `delayMs` spread by up to ±{@link RETRY_JITTER_RATIO}, the same for the same
 * client, `retryIndex` and `schedule` (a name keeping independent schedules
 * apart).
 */
export function jitterRetryDelayMs(delayMs: number, retryIndex: number, schedule: string): number {
  if (!(delayMs > 0)) return 0;
  if (!jitterEnabled) return delayMs;
  const factor = 1 - RETRY_JITTER_RATIO + 2 * RETRY_JITTER_RATIO * spreadUnit(retryIndex, schedule);
  return Math.round(delayMs * factor);
}

/**
 * Tests that time a schedule exactly turn the spread off, or pin the client's
 * seed; `null` restores a random seed with the spread on.
 */
export function setRetryJitterForTests(
  options: { readonly enabled?: boolean; readonly seed?: number } | null,
): void {
  jitterEnabled = options?.enabled ?? true;
  clientSeed = options?.seed ?? Math.random();
}
