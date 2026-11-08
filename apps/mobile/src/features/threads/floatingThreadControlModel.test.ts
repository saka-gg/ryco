import { describe, expect, it } from "vite-plus/test";

import {
  formatElapsed,
  isFollowingLatest,
  resolveFloatingThreadControl,
} from "./floatingThreadControlModel";

const START = "2026-11-07T10:00:00.000Z";
const at = (seconds: number) => Date.parse(START) + seconds * 1000;

describe("floating thread control", () => {
  it("formats the running turn's elapsed time", () => {
    expect(formatElapsed(42_400)).toBe("42s");
    expect(formatElapsed(187_000)).toBe("3:07");
    expect(formatElapsed(3_729_000)).toBe("1:02:09");
    expect(formatElapsed(-5)).toBe("0s");
  });

  it("follows the end within 160 points", () => {
    expect(isFollowingLatest({ offsetY: 840, viewportHeight: 600, contentHeight: 1600 })).toBe(
      true,
    );
    expect(isFollowingLatest({ offsetY: 800, viewportHeight: 600, contentHeight: 1600 })).toBe(
      false,
    );
  });

  it("shows Working while the agent runs, Jump to latest after scrolling back, else nothing", () => {
    expect(
      resolveFloatingThreadControl({ runningSince: START, followingLatest: true, nowMs: at(65) }),
    ).toEqual({ kind: "working", label: "Working · 1:05", accessibilityLabel: "Working · 1:05" });
    expect(
      resolveFloatingThreadControl({ runningSince: START, followingLatest: false, nowMs: at(3) }),
    ).toMatchObject({ kind: "working", accessibilityLabel: "Working · 3s. Jump to latest" });
    expect(
      resolveFloatingThreadControl({ runningSince: null, followingLatest: false, nowMs: 0 }),
    ).toMatchObject({ kind: "jump", label: "Jump to latest" });
    expect(
      resolveFloatingThreadControl({ runningSince: null, followingLatest: true, nowMs: 0 }),
    ).toBeNull();
    expect(
      resolveFloatingThreadControl({ runningSince: "bad", followingLatest: true, nowMs: 0 }),
    ).toMatchObject({ label: "Working" });
  });
});
