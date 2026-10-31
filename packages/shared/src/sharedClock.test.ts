import { describe, expect, it, vi } from "vite-plus/test";

import { createSharedClock } from "./sharedClock.ts";

// The clock over a hand-driven timer and visibility: how many timers run, when they stop, and
// what a label reads between ticks.

function harness(input: { startMs?: number; visibility?: boolean } = {}) {
  let nowMs = input.startMs ?? 1_000_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const setInterval = vi.fn((tick: () => void) => {
    nextTimer += 1;
    timers.set(nextTimer, tick);
    return nextTimer;
  });
  const clearInterval = vi.fn((timer: unknown) => {
    timers.delete(timer as number);
  });
  const clock = createSharedClock({
    intervalMs: 1000,
    now: () => nowMs,
    setInterval,
    clearInterval,
    visibility: input.visibility
      ? {
          isVisible: () => visible,
          subscribe: (onChange) => {
            visibilityListeners.add(onChange);
            return () => visibilityListeners.delete(onChange);
          },
        }
      : null,
  });
  return {
    clock,
    setInterval,
    clearInterval,
    running: () => timers.size,
    watchingVisibility: () => visibilityListeners.size,
    advance(ms: number) {
      nowMs += ms;
    },
    /** One interval passes and every running timer fires. */
    tick() {
      nowMs += 1000;
      for (const tick of timers.values()) tick();
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of visibilityListeners) listener();
    },
  };
}

describe("shared second clock", () => {
  it("runs one timer for every label and tells them all the time now and on each tick", () => {
    const h = harness();
    const first = vi.fn();
    const second = vi.fn();
    h.clock.subscribe(first);
    h.clock.subscribe(second);
    expect(first).toHaveBeenCalledWith(1_000_000);
    expect(second).toHaveBeenCalledWith(1_000_000);
    expect(h.setInterval).toHaveBeenCalledOnce();
    expect(h.running()).toBe(1);

    const before = h.clock.read();
    h.tick();
    expect(first).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenLastCalledWith(before + 1000);
    expect(second).toHaveBeenLastCalledWith(before + 1000);
    expect(h.clock.read()).toBe(before + 1000);
  });

  it("stops when the last label leaves, and starts again for the next one", () => {
    const h = harness();
    const stopFirst = h.clock.subscribe(() => undefined);
    const stopSecond = h.clock.subscribe(() => undefined);
    stopFirst();
    expect(h.clearInterval).not.toHaveBeenCalled();
    stopSecond();
    expect(h.clearInterval).toHaveBeenCalledOnce();
    expect(h.running()).toBe(0);
    // Leaving twice changes nothing.
    stopSecond();
    expect(h.clearInterval).toHaveBeenCalledOnce();

    h.clock.subscribe(() => undefined);
    expect(h.setInterval).toHaveBeenCalledTimes(2);
    expect(h.running()).toBe(1);
  });

  it("reads the same instant between ticks", () => {
    const h = harness();
    h.clock.subscribe(() => undefined);
    const read = h.clock.read();
    h.advance(400);
    expect(h.clock.read()).toBe(read);
  });

  it("reads the time now for a label that mounts long after the clock stopped", () => {
    const h = harness();
    const stop = h.clock.subscribe(() => undefined);
    stop();
    h.advance(60 * 60_000);
    const read = h.clock.read();
    expect(read).toBe(1_000_000 + 60 * 60_000);
    // A snapshot: read again at once, it answers the same.
    h.advance(10);
    expect(h.clock.read()).toBe(read);
  });

  it("reads the time now once the system clock was set back while it was stopped", () => {
    const h = harness();
    h.clock.read();
    h.advance(-60_000);
    expect(h.clock.read()).toBe(1_000_000 - 60_000);
  });
});

describe("shared second clock with a visibility source", () => {
  it("stops while hidden and ticks at once when visible again", () => {
    const h = harness({ visibility: true });
    const listener = vi.fn();
    h.clock.subscribe(listener);
    expect(h.running()).toBe(1);

    h.setVisible(false);
    expect(h.clearInterval).toHaveBeenCalledOnce();
    expect(h.running()).toBe(0);
    h.tick();
    expect(listener).toHaveBeenCalledOnce();

    h.advance(5000);
    h.setVisible(true);
    expect(listener).toHaveBeenLastCalledWith(1_000_000 + 6000);
    expect(h.clock.read()).toBe(1_000_000 + 6000);
    expect(h.setInterval).toHaveBeenCalledTimes(2);
  });

  it("starts no timer while hidden, and stops watching once the last label leaves", () => {
    const h = harness({ visibility: true });
    h.setVisible(false);
    const stop = h.clock.subscribe(() => undefined);
    expect(h.setInterval).not.toHaveBeenCalled();
    expect(h.watchingVisibility()).toBe(1);

    stop();
    expect(h.watchingVisibility()).toBe(0);
    // Shown again with no label listening: nothing starts.
    h.setVisible(true);
    expect(h.setInterval).not.toHaveBeenCalled();
  });
});

describe("createSharedClock subscribe", () => {
  it("tells a new label the instant the running labels show, and ticks first when stopped", () => {
    let nowMs = 10_000;
    let tick: (() => void) | undefined;
    const clock = createSharedClock({
      intervalMs: 1000,
      now: () => nowMs,
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        tick = undefined;
      },
    });
    const first: number[] = [];
    clock.subscribe((value) => first.push(value));
    expect(first).toEqual([10_000]);
    expect(clock.read()).toBe(10_000);

    nowMs = 10_600;
    const second: number[] = [];
    clock.subscribe((value) => second.push(value));
    // Mid-interval: the same instant as the first label and as read().
    expect(second).toEqual([10_000]);
    expect(clock.read()).toBe(10_000);
    nowMs = 11_000;
    tick?.();
    expect(first.at(-1)).toBe(11_000);
    expect(second.at(-1)).toBe(11_000);
  });

  it("never keeps a listener that throws on subscribe", () => {
    let running = false;
    const clock = createSharedClock({
      intervalMs: 1000,
      now: () => 0,
      setInterval: () => {
        running = true;
        return 1;
      },
      clearInterval: () => {
        running = false;
      },
    });
    expect(() =>
      clock.subscribe(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(running).toBe(false);
  });
});
