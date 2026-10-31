/**
 * One clock for every on-screen time that counts up, shared by web and the phone. A single timer
 * runs while at least one label listens and stops when the last one leaves, so labels tick
 * together and nothing ticks once they are gone. Given a visibility source (web: the document),
 * it also stops while the page is hidden and ticks at once when it shows again.
 *
 * @module sharedClock
 */

export type SharedClockListener = (nowMs: number) => void;

export interface SharedClock {
  /** Tells `listener` the time now at once, then on every tick. Returns its unsubscribe. */
  readonly subscribe: (listener: SharedClockListener) => () => void;
  /**
   * A `useSyncExternalStore` snapshot: the instant of the last tick, the same value until the
   * next one.
   */
  readonly read: () => number;
}

/** Whether the labels can be seen, and a way to hear when that changes. */
export interface SharedClockVisibility {
  readonly isVisible: () => boolean;
  readonly subscribe: (onChange: () => void) => () => void;
}

export interface SharedClockOptions {
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly setInterval?: (tick: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
  /** Without one the clock runs whenever a label listens. */
  readonly visibility?: SharedClockVisibility | null;
}

export function createSharedClock(options: SharedClockOptions): SharedClock {
  const now = options.now ?? (() => Date.now());
  const startTimer =
    options.setInterval ??
    ((tick: () => void, intervalMs: number) => setInterval(tick, intervalMs));
  const stopTimer =
    options.clearInterval ??
    ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));
  const visibility = options.visibility ?? null;
  const listeners = new Set<SharedClockListener>();
  let timer: unknown = null;
  let stopWatchingVisibility: (() => void) | null = null;
  let nowMs = now();

  const isVisible = () => visibility?.isVisible() ?? true;
  const tick = () => {
    nowMs = now();
    for (const listener of listeners) listener(nowMs);
  };
  const start = () => {
    if (timer !== null || listeners.size === 0 || !isVisible()) return;
    timer = startTimer(tick, options.intervalMs);
  };
  const stop = () => {
    if (timer === null) return;
    stopTimer(timer);
    timer = null;
  };
  const onVisibilityChange = () => {
    if (!isVisible()) {
      stop();
      return;
    }
    tick();
    start();
  };

  return {
    read: () => {
      // Stopped, the last tick may be long past (or the system clock was set back): a label
      // that mounts later reads the time now. Within one interval it reads the same value
      // again, as the snapshot contract requires.
      if (timer === null) {
        const current = now();
        if (Math.abs(current - nowMs) >= options.intervalMs) nowMs = current;
      }
      return nowMs;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      if (visibility !== null && stopWatchingVisibility === null) {
        stopWatchingVisibility = visibility.subscribe(onVisibilityChange);
      }
      listener(now());
      start();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop();
        stopWatchingVisibility?.();
        stopWatchingVisibility = null;
      };
    },
  };
}
