import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createWriteScheduler } from "./storage";

describe("createWriteScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs only the latest write of a burst, once it settles", () => {
    vi.useFakeTimers();
    const scheduler = createWriteScheduler(300);
    const writes: string[] = [];
    for (const value of ["a", "ab", "abc"]) scheduler.schedule(() => writes.push(value));
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(writes).toEqual(["abc"]);
  });

  it("runs the pending write on flush, and nothing when none is pending", () => {
    vi.useFakeTimers();
    const scheduler = createWriteScheduler(300);
    const write = vi.fn();
    scheduler.flush();
    scheduler.schedule(write);
    scheduler.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
