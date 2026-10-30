/**
 * One clock for every on-screen time that counts up. A single timer runs while at least one
 * label listens and stops when the last one leaves, so labels tick together and nothing ticks
 * once they are gone. `read` is a `useSyncExternalStore` snapshot: the instant of the last
 * tick, the same value until the next one.
 */
export interface SharedClock {
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => number;
}

export interface SharedClockOptions {
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly setInterval?: (tick: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (timer: unknown) => void;
}

export function createSharedClock(options: SharedClockOptions): SharedClock {
  const now = options.now ?? (() => Date.now());
  const startTimer =
    options.setInterval ??
    ((tick: () => void, intervalMs: number) => setInterval(tick, intervalMs));
  const stopTimer =
    options.clearInterval ??
    ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let nowMs = now();
  const tick = () => {
    nowMs = now();
    for (const listener of listeners) listener();
  };
  return {
    read: () => {
      // Stopped, the last tick may be long past: a label that mounts later reads the time now.
      // Within one interval it reads the same value again, as the snapshot contract requires.
      if (timer === null) {
        const current = now();
        if (current - nowMs >= options.intervalMs) nowMs = current;
      }
      return nowMs;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === null) timer = startTimer(tick, options.intervalMs);
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0 || timer === null) return;
        stopTimer(timer);
        timer = null;
      };
    },
  };
}

/** The phone's once-a-second clock for elapsed times. */
export const secondClock = createSharedClock({ intervalMs: 1000 });
