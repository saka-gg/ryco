import { describe, expect, it } from "vite-plus/test";

import {
  resolveAutoSettleAfterDays,
  compareActiveInboxEntries,
  compareSettledInboxEntries,
  canSettleThread,
  classifyThreadSettlement,
  getEffectiveSettlementTimestamp,
  getNextThreadSettlementEvaluationAtMs,
  getThreadLastActivityTimestamp,
  hasQueuedTurnStart,
  type ThreadSettlementInput,
} from "./threadSettlement.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");

function input(overrides: Partial<ThreadSettlementInput> = {}): ThreadSettlementInput {
  return {
    threadSettlementSupported: true,
    archivedAt: null,
    deletedAt: null,
    worktreeArchivedAt: null,
    settledOverride: null,
    settledAt: null,
    sessionStatus: "idle",
    latestTurnState: "completed",
    latestTurnRequestedAt: "2026-07-31T10:00:00.000Z",
    latestTurnStartedAt: "2026-07-31T10:00:30.000Z",
    latestTurnCompletedAt: "2026-07-31T10:01:00.000Z",
    latestUserMessageAt: "2026-07-31T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasLocalQueuedMessage: false,
    deliveryUnknown: false,
    prState: null,
    worktreeUpdatedAt: null,
    updatedAt: "2026-07-31T10:01:00.000Z",
    createdAt: "2026-07-31T09:59:00.000Z",
    autoSettleAfterDays: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("hasQueuedTurnStart", () => {
  it("blocks a recent user message not adopted by a latest turn", () => {
    expect(
      hasQueuedTurnStart(
        input({
          latestTurnRequestedAt: "2026-07-31T11:55:00.000Z",
          latestUserMessageAt: "2026-07-31T11:59:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("accepts a recent message adopted by the latest turn", () => {
    expect(
      hasQueuedTurnStart(
        input({
          latestTurnRequestedAt: "2026-07-31T11:59:30.000Z",
          latestUserMessageAt: "2026-07-31T11:59:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("tolerates small future clock skew and expires old unmatched messages", () => {
    expect(
      hasQueuedTurnStart(
        input({
          latestTurnRequestedAt: null,
          latestUserMessageAt: "2026-07-31T12:01:00.000Z",
        }),
      ),
    ).toBe(true);
    expect(
      hasQueuedTurnStart(
        input({
          latestTurnRequestedAt: null,
          latestUserMessageAt: "2026-07-31T11:57:59.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("clears the queued condition after a failed turn/session start", () => {
    expect(
      hasQueuedTurnStart(
        input({
          latestTurnState: "error",
          latestTurnRequestedAt: null,
          latestUserMessageAt: "2026-07-31T11:59:00.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      hasQueuedTurnStart(
        input({
          sessionStatus: "error",
          latestTurnRequestedAt: null,
          latestUserMessageAt: "2026-07-31T11:59:00.000Z",
        }),
      ),
    ).toBe(false);
  });
});

describe("canSettleThread", () => {
  it.each([
    ["unsupported", { threadSettlementSupported: false }],
    ["thread-archived", { archivedAt: "2026-07-31T11:00:00.000Z" }],
    ["thread-deleted", { deletedAt: "2026-07-31T11:00:00.000Z" }],
    ["worktree-archived", { worktreeArchivedAt: "2026-07-31T11:00:00.000Z" }],
    ["pending-approval", { hasPendingApprovals: true }],
    ["pending-user-input", { hasPendingUserInput: true }],
    ["session-starting", { sessionStatus: "starting" }],
    ["session-running", { sessionStatus: "running" }],
    ["local-queue", { hasLocalQueuedMessage: true }],
    ["delivery-unknown", { deliveryUnknown: true }],
  ] as const)("reports %s", (blocker, overrides) => {
    expect(canSettleThread(input(overrides))).toEqual({ canSettle: false, blocker });
  });

  it("allows an eligible idle thread", () => {
    expect(canSettleThread(input())).toEqual({ canSettle: true, blocker: null });
  });
});

describe("classifyThreadSettlement", () => {
  it("keeps blockers active ahead of explicit or automatic settlement", () => {
    expect(
      classifyThreadSettlement(
        input({
          settledOverride: "settled",
          settledAt: "2026-07-31T11:00:00.000Z",
          hasPendingApprovals: true,
          prState: "merged",
        }),
      ),
    ).toBe("active");
  });

  it("honors explicit settlement and explicit keep-active", () => {
    expect(
      classifyThreadSettlement(
        input({
          settledOverride: "settled",
          settledAt: "2026-07-31T11:00:00.000Z",
        }),
      ),
    ).toBe("settled");
    expect(classifyThreadSettlement(input({ settledOverride: "active", prState: "merged" }))).toBe(
      "active",
    );
  });

  it("automatically settles merged/closed PR work and wakes it when reopened", () => {
    expect(classifyThreadSettlement(input({ prState: "merged" }))).toBe("settled");
    expect(classifyThreadSettlement(input({ prState: "closed" }))).toBe("settled");
    expect(classifyThreadSettlement(input({ prState: "open" }))).toBe("active");
  });

  it("settles inactive work only when the opt-in boundary has passed", () => {
    const inactive = input({
      autoSettleAfterDays: 7,
      nowMs: Date.parse("2026-08-07T10:01:00.000Z"),
    });
    expect(classifyThreadSettlement(inactive)).toBe("settled");
    expect(getEffectiveSettlementTimestamp(inactive)).toBe("2026-08-07T10:01:00.000Z");
    expect(
      classifyThreadSettlement(
        input({
          autoSettleAfterDays: 7,
          nowMs: Date.parse("2026-08-07T10:00:59.999Z"),
        }),
      ),
    ).toBe("active");
  });

  it("protects explicit keep-active work, open PRs, blockers, and threads without activity", () => {
    const autoSettleAfterDays = 7;
    const nowMs = Date.parse("2026-08-08T12:00:00.000Z");
    expect(
      classifyThreadSettlement(input({ autoSettleAfterDays, nowMs, settledOverride: "active" })),
    ).toBe("active");
    expect(classifyThreadSettlement(input({ autoSettleAfterDays, nowMs, prState: "open" }))).toBe(
      "active",
    );
    expect(
      classifyThreadSettlement(input({ autoSettleAfterDays, nowMs, deliveryUnknown: true })),
    ).toBe("active");
    expect(
      classifyThreadSettlement(
        input({
          autoSettleAfterDays,
          nowMs,
          latestTurnRequestedAt: null,
          latestTurnStartedAt: null,
          latestTurnCompletedAt: null,
          latestUserMessageAt: null,
        }),
      ),
    ).toBe("active");
  });

  it("excludes archived threads and worktrees", () => {
    expect(classifyThreadSettlement(input({ archivedAt: "2026-07-31T11:00:00.000Z" }))).toBe(
      "excluded",
    );
    expect(
      classifyThreadSettlement(input({ worktreeArchivedAt: "2026-07-31T11:00:00.000Z" })),
    ).toBe("excluded");
  });

  it("does not hide automatic PR work without a valid ordering timestamp", () => {
    expect(
      classifyThreadSettlement(
        input({
          prState: "merged",
          worktreeUpdatedAt: "invalid",
          latestTurnCompletedAt: null,
          latestUserMessageAt: null,
          updatedAt: "invalid",
          createdAt: "invalid",
        }),
      ),
    ).toBe("active");
  });
});

describe("effective settlement timestamp and sorting", () => {
  it("uses activity timestamps only and exposes the next exact evaluation boundary", () => {
    const nextBoundary = Date.parse("2026-08-07T10:01:00.000Z");
    const candidate = input({
      autoSettleAfterDays: 7,
      nowMs: NOW,
      updatedAt: "2026-07-31T11:59:00.000Z",
    });
    expect(getThreadLastActivityTimestamp(candidate)).toBe("2026-07-31T10:01:00.000Z");
    expect(getNextThreadSettlementEvaluationAtMs(candidate)).toBe(nextBoundary);
  });

  it("prefers explicit settlement and otherwise takes the newest valid candidate", () => {
    expect(
      getEffectiveSettlementTimestamp(
        input({
          settledOverride: "settled",
          settledAt: "2026-07-31T11:30:00.000Z",
          worktreeUpdatedAt: "2026-07-31T11:59:00.000Z",
        }),
      ),
    ).toBe("2026-07-31T11:30:00.000Z");
    expect(
      getEffectiveSettlementTimestamp(
        input({
          prState: "merged",
          worktreeUpdatedAt: "invalid",
          latestTurnCompletedAt: "2026-07-31T11:20:00.000Z",
          updatedAt: "2026-07-31T11:10:00.000Z",
        }),
      ),
    ).toBe("2026-07-31T11:20:00.000Z");
  });

  it("sorts active entries by pin, creation time, and scoped key", () => {
    const entries = [
      { scopedKey: "b:2", pinned: false, createdAt: "2026-07-31T11:00:00.000Z" },
      { scopedKey: "a:1", pinned: true, createdAt: "2026-07-31T09:00:00.000Z" },
      { scopedKey: "a:2", pinned: false, createdAt: "2026-07-31T11:00:00.000Z" },
    ];
    expect(entries.toSorted(compareActiveInboxEntries).map((entry) => entry.scopedKey)).toEqual([
      "a:1",
      "a:2",
      "b:2",
    ]);
  });

  it("sorts settled entries by effective time, creation time, and scoped key", () => {
    const entries = [
      {
        scopedKey: "b:2",
        effectiveSettlementTimestamp: "2026-07-31T10:00:00.000Z",
        createdAt: "2026-07-31T09:00:00.000Z",
      },
      {
        scopedKey: "a:1",
        effectiveSettlementTimestamp: "2026-07-31T11:00:00.000Z",
        createdAt: "2026-07-31T08:00:00.000Z",
      },
      {
        scopedKey: "a:2",
        effectiveSettlementTimestamp: "2026-07-31T10:00:00.000Z",
        createdAt: "2026-07-31T09:00:00.000Z",
      },
    ];
    expect(entries.toSorted(compareSettledInboxEntries).map((entry) => entry.scopedKey)).toEqual([
      "a:1",
      "a:2",
      "b:2",
    ]);
  });
});

describe("default inactivity policy", () => {
  it("defaults to seven days without overriding explicit Off or custom intervals", () => {
    expect(resolveAutoSettleAfterDays(undefined)).toBe(7);
    expect(resolveAutoSettleAfterDays(null)).toBeNull();
    expect(resolveAutoSettleAfterDays(14)).toBe(14);
  });
  it("protects a running turn before session state catches up", () => {
    const running = input({
      sessionStatus: null,
      latestTurnState: "running",
      autoSettleAfterDays: 7,
      nowMs: NOW + 30 * 86400000,
    });
    expect(canSettleThread(running)).toEqual({ canSettle: false, blocker: "session-running" });
    expect(classifyThreadSettlement(running)).toBe("active");
  });
});
