import { scheduleIdleTask } from "./idleTask";

/**
 * Gap between two speculative thread retains (sibling tabs, sidebar prewarm),
 * so their windows never arrive as a burst next to the thread being opened.
 */
export const THREAD_PREFETCH_STAGGER_MS = 100;

/**
 * Retains `keys` one at a time: the first in an idle slot, each next one
 * {@link THREAD_PREFETCH_STAGGER_MS} later. Returns a function that
 * cancels the retains that have not started and releases those that have.
 */
export function startStaggeredThreadPrefetch(
  keys: ReadonlyArray<string>,
  retain: (key: string) => (() => void) | null,
  timers: {
    readonly scheduleIdle?: (callback: () => void) => () => void;
    readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
  } = {},
): () => void {
  const scheduleIdle = timers.scheduleIdle ?? scheduleIdleTask;
  const setTimer =
    timers.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    timers.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const releases: Array<() => void> = [];
  let index = 0;
  let cancelPending: (() => void) | null = null;
  const retainNext = () => {
    cancelPending = null;
    const key = keys[index];
    if (key === undefined) return;
    index += 1;
    const release = retain(key);
    if (release) releases.push(release);
    if (index >= keys.length) return;
    const handle = setTimer(retainNext, THREAD_PREFETCH_STAGGER_MS);
    cancelPending = () => clearTimer(handle);
  };
  cancelPending = scheduleIdle(retainNext);
  return () => {
    cancelPending?.();
    cancelPending = null;
    for (const release of releases) release();
    releases.length = 0;
  };
}
