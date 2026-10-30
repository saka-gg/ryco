import { describe, expect, it, vi } from "vite-plus/test";

import { createSharedClock } from "./secondClock";

// The clock over a hand-driven timer: how many timers run, when they stop, and what a
// label reads between ticks.

function harness(startMs = 1_000_000) {
  let nowMs = startMs;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
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
  });
  return {
    clock,
    setInterval,
    clearInterval,
    running: () => timers.size,
    advance(ms: number) {
      nowMs += ms;
    },
    /** One interval passes and every running timer fires. */
    tick() {
      nowMs += 1000;
      for (const tick of timers.values()) tick();
    },
  };
}

describe("shared second clock", () => {
  it("runs one timer for every label and tells them all on each tick", () => {
    const h = harness();
    const first = vi.fn();
    const second = vi.fn();
    h.clock.subscribe(first);
    h.clock.subscribe(second);
    expect(h.setInterval).toHaveBeenCalledOnce();
    expect(h.running()).toBe(1);

    const before = h.clock.read();
    h.tick();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
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
});
