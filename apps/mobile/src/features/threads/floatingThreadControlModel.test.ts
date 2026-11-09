import { describe, expect, it } from "vite-plus/test";

import {
  floatingThreadControlTicks,
  formatElapsed,
  isFollowingLatest,
  resolveFloatingThreadControl,
  showsFloatingThreadCapsule,
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

  const base = {
    runningSince: null,
    followingLatest: true,
    nowMs: 0,
    attention: null,
    childAttention: null,
  } as const;

  it("shows Working while the agent runs, the jump button after scrolling back, else nothing", () => {
    expect(resolveFloatingThreadControl({ ...base, runningSince: START, nowMs: at(65) })).toEqual({
      status: { kind: "working", label: "Working · 1:05", accessibilityLabel: "Working · 1:05" },
      jump: false,
    });
    expect(
      resolveFloatingThreadControl({
        ...base,
        runningSince: START,
        followingLatest: false,
        nowMs: at(3),
      }),
    ).toMatchObject({
      status: { kind: "working", accessibilityLabel: "Working · 3s. Jump to latest" },
      jump: true,
    });
    expect(resolveFloatingThreadControl({ ...base, followingLatest: false })).toEqual({
      status: null,
      jump: true,
    });
    expect(resolveFloatingThreadControl(base)).toEqual({ status: null, jump: false });
    expect(resolveFloatingThreadControl({ ...base, runningSince: "bad" })).toMatchObject({
      status: { label: "Working" },
    });
  });

  it("puts what the chat waits on before its progress", () => {
    expect(
      resolveFloatingThreadControl({ ...base, runningSince: START, attention: "approval" }),
    ).toMatchObject({ status: { kind: "attention", label: "Needs your approval" } });
    expect(resolveFloatingThreadControl({ ...base, attention: "question" })).toMatchObject({
      status: { kind: "attention", label: "Waiting for your answer" },
    });
  });

  it("points at a delegated chat that waits on the reader", () => {
    const child = { threadId: "child-1", title: "Fix the relay" };
    expect(
      resolveFloatingThreadControl({ ...base, runningSince: START, childAttention: child }),
    ).toEqual({
      status: {
        kind: "child-attention",
        label: "Delegated chat needs you",
        accessibilityLabel: "Fix the relay needs you. Open it.",
        threadId: "child-1",
      },
      jump: false,
    });
    // This chat's own card still comes first.
    expect(
      resolveFloatingThreadControl({ ...base, attention: "question", childAttention: child }),
    ).toMatchObject({ status: { kind: "attention" } });
  });

  it("keeps room under the newest message whenever the capsule shows, not only while working", () => {
    const idle = { runningSince: null, attention: null, childAttention: null, agentsLive: false };
    expect(showsFloatingThreadCapsule(idle)).toBe(false);
    expect(showsFloatingThreadCapsule({ ...idle, runningSince: START })).toBe(true);
    expect(showsFloatingThreadCapsule({ ...idle, attention: "approval" })).toBe(true);
    expect(showsFloatingThreadCapsule({ ...idle, attention: "question" })).toBe(true);
    expect(
      showsFloatingThreadCapsule({
        ...idle,
        childAttention: { threadId: "child-1", title: "Fix the relay" },
      }),
    ).toBe(true);
    expect(showsFloatingThreadCapsule({ ...idle, agentsLive: true })).toBe(true);
  });

  it("reads the clock only while the label shows the elapsed time", () => {
    const child = { threadId: "child-1", title: "Fix the relay" };
    const running = { runningSince: START, attention: null, childAttention: null };
    expect(floatingThreadControlTicks(running)).toBe(true);
    expect(floatingThreadControlTicks({ ...running, runningSince: null })).toBe(false);
    expect(floatingThreadControlTicks({ ...running, attention: "approval" })).toBe(false);
    // "Delegated chat needs you" has no time in it.
    expect(floatingThreadControlTicks({ ...running, childAttention: child })).toBe(false);
  });
});
