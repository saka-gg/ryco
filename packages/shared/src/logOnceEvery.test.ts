import { describe, expect, it } from "vite-plus/test";

import { LogOnceEveryLimiter } from "./logOnceEvery.ts";

const WINDOW_MS = 60_000;

describe("LogOnceEveryLimiter", () => {
  it("logs the first occurrence and skips repeats inside the window", () => {
    const limiter = new LogOnceEveryLimiter();
    expect(limiter.admit("refresh", WINDOW_MS, 0)).toEqual({ kind: "log", unreportedRepeats: 0 });
    expect(limiter.admit("refresh", WINDOW_MS, 1_000)).toEqual({ kind: "skip" });
    expect(limiter.admit("refresh", WINDOW_MS, 59_999)).toEqual({ kind: "skip" });
  });

  it("summarizes a continuing burst once per window", () => {
    const limiter = new LogOnceEveryLimiter();
    limiter.admit("refresh", WINDOW_MS, 0);
    for (let at = 10_000; at < WINDOW_MS; at += 10_000) {
      limiter.admit("refresh", WINDOW_MS, at);
    }
    expect(limiter.admit("refresh", WINDOW_MS, 65_000)).toEqual({
      kind: "summary",
      repeats: 6,
      sinceMs: 0,
    });
    expect(limiter.admit("refresh", WINDOW_MS, 70_000)).toEqual({ kind: "skip" });
    expect(limiter.admit("refresh", WINDOW_MS, 110_000)).toEqual({ kind: "skip" });
    expect(limiter.admit("refresh", WINDOW_MS, 126_000)).toEqual({
      kind: "summary",
      repeats: 3,
      sinceMs: 65_000,
    });
  });

  it("logs a single occurrence after a full window in full again", () => {
    const limiter = new LogOnceEveryLimiter();
    limiter.admit("refresh", WINDOW_MS, 0);
    expect(limiter.admit("refresh", WINDOW_MS, WINDOW_MS)).toEqual({
      kind: "log",
      unreportedRepeats: 0,
    });
  });

  it("starts a new burst in full after a quiet window and carries the unreported count", () => {
    const limiter = new LogOnceEveryLimiter();
    limiter.admit("refresh", WINDOW_MS, 0);
    limiter.admit("refresh", WINDOW_MS, 1_000);
    limiter.admit("refresh", WINDOW_MS, 2_000);
    expect(limiter.admit("refresh", WINDOW_MS, 10 * WINDOW_MS)).toEqual({
      kind: "log",
      unreportedRepeats: 2,
    });
    expect(limiter.admit("refresh", WINDOW_MS, 10 * WINDOW_MS + 1)).toEqual({ kind: "skip" });
  });

  it("tracks keys independently", () => {
    const limiter = new LogOnceEveryLimiter();
    expect(limiter.admit("a", WINDOW_MS, 0).kind).toBe("log");
    expect(limiter.admit("b", WINDOW_MS, 0).kind).toBe("log");
    expect(limiter.admit("a", WINDOW_MS, 1).kind).toBe("skip");
  });

  it("forgets the least recently seen key beyond maxKeys", () => {
    const limiter = new LogOnceEveryLimiter({ maxKeys: 2 });
    limiter.admit("a", WINDOW_MS, 0);
    limiter.admit("b", WINDOW_MS, 0);
    // Seeing "a" again makes "b" the least recently seen.
    limiter.admit("a", WINDOW_MS, 1);
    limiter.admit("c", WINDOW_MS, 2);
    expect(limiter.size).toBe(2);
    expect(limiter.admit("a", WINDOW_MS, 3).kind).toBe("skip");
    expect(limiter.admit("b", WINDOW_MS, 3).kind).toBe("log");
  });

  it("does not stay silent when the clock goes backwards", () => {
    const limiter = new LogOnceEveryLimiter();
    limiter.admit("refresh", WINDOW_MS, 100_000);
    expect(limiter.admit("refresh", WINDOW_MS, 50_000).kind).toBe("log");
  });
});
