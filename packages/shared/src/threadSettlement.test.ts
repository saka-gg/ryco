import { describe, expect, it } from "vite-plus/test";

import {
  resolveAutoSettleAfterDays,
  compareActiveInboxEntries,
  compareSettledInboxEntries,
  canSettleThread,
  classifyThreadSettlement,
  getEffectiveSettlementTimestamp,
  getNextThreadSettlementEvaluationAtMs,
  getThreadAutoSettlementBlocker,
  getThreadLastActivityTimestamp,
  hasQueuedTurnStart,
  queuedTurnIdleBlocker,
  type QueuedTurnIdleInput,
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
    pinned: false,
    backgroundLiveness: null,
    prNumber: null,
    prState: null,
    prTerminalAt: null,
    worktreeUpdatedAt: null,
    updatedAt: "2026-07-31T10:01:00.000Z",
    createdAt: "2026-07-31T09:59:00.000Z",
    autoSettleAfterDays: null,
    nowMs: NOW,
    ...overrides,
  };
}

function idleInput(overrides: Partial<QueuedTurnIdleInput> = {}): QueuedTurnIdleInput {
  return {
    archivedAt: null,
    sessionStatus: "ready",
    latestTurnState: "completed",
    latestTurnRequestedAt: "2026-07-31T10:00:00.000Z",
    latestUserMessageAt: "2026-07-31T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("queuedTurnIdleBlocker", () => {
  it("lets a server-queued turn start on a ready thread with monitoring-only work", () => {
    expect(queuedTurnIdleBlocker(idleInput())).toBeNull();
    expect(queuedTurnIdleBlocker(idleInput({ backgroundLiveness: "monitoring" }))).toBeNull();
    expect(queuedTurnIdleBlocker(idleInput({ sessionStatus: null }))).toBeNull();
    expect(queuedTurnIdleBlocker(idleInput({ sessionStatus: "stopped" }))).toBeNull();
    expect(queuedTurnIdleBlocker(idleInput({ sessionStatus: "error" }))).toBeNull();
  });

  it.each([
    [{ archivedAt: "2026-07-31T11:00:00.000Z" }, "thread-archived"],
    [{ hasPendingApprovals: true }, "pending-approval"],
    [{ hasPendingUserInput: true }, "pending-user-input"],
    [{ sessionStatus: "starting" as const }, "session-starting"],
    [{ sessionStatus: "running" as const }, "session-running"],
    [{ latestTurnState: "running" as const }, "session-running"],
    [{ backgroundLiveness: "working" as const }, "background-working"],
    [
      {
        latestTurnRequestedAt: "2026-07-31T11:55:00.000Z",
        latestUserMessageAt: "2026-07-31T11:59:00.000Z",
      },
      "queued-turn",
    ],
  ] satisfies ReadonlyArray<[Partial<QueuedTurnIdleInput>, string]>)(
    "blocks on %o",
    (overrides, blocker) => {
      expect(queuedTurnIdleBlocker(idleInput(overrides))).toBe(blocker);
    },
  );

  it("stops treating an unadopted user message as queued after the grace", () => {
    expect(
      queuedTurnIdleBlocker(
        idleInput({
          latestTurnRequestedAt: "2026-07-31T11:50:00.000Z",
          latestUserMessageAt: "2026-07-31T11:55:00.000Z",
        }),
      ),
    ).toBeNull();
  });
});

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

  it.each(["merged", "closed"] as const)(
    "settles a %s PR only when it closed at or after the user's last activity",
    (prState) => {
      const closedAfterActivity = input({
        prNumber: 12,
        prState,
        prTerminalAt: "2026-07-31T11:00:00.000Z",
      });
      expect(classifyThreadSettlement(closedAfterActivity)).toBe("settled");
      expect(getEffectiveSettlementTimestamp(closedAfterActivity)).toBe("2026-07-31T11:00:00.000Z");

      const closedBeforeActivity = input({
        prNumber: 12,
        prState,
        prTerminalAt: "2026-07-31T09:59:30.000Z",
      });
      expect(classifyThreadSettlement(closedBeforeActivity)).toBe("active");
      expect(getEffectiveSettlementTimestamp(closedBeforeActivity)).toBeNull();

      const pastInactivityBoundary = input({
        prNumber: 12,
        prState,
        prTerminalAt: "2026-07-31T09:59:30.000Z",
        autoSettleAfterDays: 7,
        nowMs: Date.parse("2026-08-07T10:01:00.000Z"),
      });
      expect(classifyThreadSettlement(pastInactivityBoundary)).toBe("settled");
      expect(getEffectiveSettlementTimestamp(pastInactivityBoundary)).toBe(
        "2026-08-07T10:01:00.000Z",
      );
    },
  );

  it("wakes a reopened PR", () => {
    expect(classifyThreadSettlement(input({ prNumber: 12, prState: "open" }))).toBe("active");
  });

  it("does not bounce a thread moved to Active back to settled after a new message", () => {
    // Merged at 11:00; the user moved the thread to Active and wrote again at 11:30,
    // which cleared the explicit override (thread.unsettled reason "activity").
    const afterNewMessage = input({
      prNumber: 12,
      prState: "merged",
      prTerminalAt: "2026-07-31T11:00:00.000Z",
      settledOverride: null,
      latestUserMessageAt: "2026-07-31T11:30:00.000Z",
      latestTurnRequestedAt: "2026-07-31T11:30:00.000Z",
      latestTurnStartedAt: "2026-07-31T11:30:05.000Z",
      latestTurnCompletedAt: "2026-07-31T11:31:00.000Z",
    });
    expect(classifyThreadSettlement(afterNewMessage)).toBe("active");
  });

  it("anchors the PR rule on createdAt and latestTurnRequestedAt as well as messages", () => {
    const noActivity = {
      latestUserMessageAt: null,
      latestTurnRequestedAt: null,
      latestTurnStartedAt: null,
      latestTurnCompletedAt: null,
    };
    expect(
      classifyThreadSettlement(
        input({
          ...noActivity,
          prNumber: 12,
          prState: "merged",
          prTerminalAt: "2026-07-31T10:30:00.000Z",
          createdAt: "2026-07-31T10:45:00.000Z",
        }),
      ),
    ).toBe("active");
    expect(
      classifyThreadSettlement(
        input({
          ...noActivity,
          prNumber: 12,
          prState: "merged",
          prTerminalAt: "2026-07-31T10:50:00.000Z",
          createdAt: "2026-07-31T10:45:00.000Z",
        }),
      ),
    ).toBe("settled");
    // A turn requested (e.g. by Agent Control) after the merge, without a new user message.
    expect(
      classifyThreadSettlement(
        input({
          prNumber: 12,
          prState: "merged",
          prTerminalAt: "2026-07-31T10:30:00.000Z",
          latestTurnRequestedAt: "2026-07-31T11:00:00.000Z",
          latestTurnStartedAt: "2026-07-31T11:00:30.000Z",
          latestTurnCompletedAt: "2026-07-31T11:01:00.000Z",
        }),
      ),
    ).toBe("active");
  });

  it("keeps the pre-existing merged rule for servers that predate prTerminalAt", () => {
    const legacy = input({
      prNumber: 12,
      prState: "merged",
      prTerminalAt: undefined,
      worktreeUpdatedAt: "2026-07-31T11:40:00.000Z",
    });
    expect(classifyThreadSettlement(legacy)).toBe("settled");
    expect(getEffectiveSettlementTimestamp(legacy)).toBe("2026-07-31T11:40:00.000Z");
    expect(
      classifyThreadSettlement(input({ prNumber: 12, prState: "closed", prTerminalAt: undefined })),
    ).toBe("settled");
  });

  it("falls back to inactivity for an invalid prTerminalAt", () => {
    expect(
      classifyThreadSettlement(input({ prNumber: 12, prState: "merged", prTerminalAt: "invalid" })),
    ).toBe("active");
    const pastBoundary = input({
      prNumber: 12,
      prState: "merged",
      prTerminalAt: "invalid",
      autoSettleAfterDays: 7,
      nowMs: Date.parse("2026-08-07T10:01:00.000Z"),
    });
    expect(classifyThreadSettlement(pastBoundary)).toBe("settled");
    expect(getEffectiveSettlementTimestamp(pastBoundary)).toBe("2026-08-07T10:01:00.000Z");
  });

  it("blocks automatic but not manual settlement for an unknown PR state", () => {
    const unknown = input({
      prNumber: 12,
      prState: null,
      autoSettleAfterDays: 7,
      nowMs: Date.parse("2026-08-08T12:00:00.000Z"),
    });
    expect(classifyThreadSettlement(unknown)).toBe("active");
    expect(getThreadAutoSettlementBlocker(unknown)).toBe("pull-request-unknown");
    expect(getNextThreadSettlementEvaluationAtMs(unknown)).toBeNull();
    expect(canSettleThread(unknown).canSettle).toBe(true);

    const issueOnly = input({
      prNumber: null,
      prState: null,
      autoSettleAfterDays: 7,
      nowMs: Date.parse("2026-08-08T12:00:00.000Z"),
    });
    expect(getThreadAutoSettlementBlocker(issueOnly)).toBeNull();
    expect(classifyThreadSettlement(issueOnly)).toBe("settled");
  });

  it("names the open PR blocker", () => {
    expect(getThreadAutoSettlementBlocker(input({ prNumber: 12, prState: "open" }))).toBe(
      "pull-request-open",
    );
    expect(getThreadAutoSettlementBlocker(input())).toBeNull();
  });

  it("blocks automatic settlement for pinned threads only", () => {
    const pinnedMerged = input({
      pinned: true,
      prNumber: 12,
      prState: "merged",
      prTerminalAt: "2026-07-31T11:00:00.000Z",
    });
    expect(getThreadAutoSettlementBlocker(pinnedMerged)).toBe("pinned");
    expect(classifyThreadSettlement(pinnedMerged)).toBe("active");
    expect(getEffectiveSettlementTimestamp(pinnedMerged)).toBeNull();
    expect(
      classifyThreadSettlement(
        input({
          pinned: true,
          autoSettleAfterDays: 7,
          nowMs: Date.parse("2026-08-08T12:00:00.000Z"),
        }),
      ),
    ).toBe("active");
    expect(
      classifyThreadSettlement(
        input({
          pinned: true,
          settledOverride: "settled",
          settledAt: "2026-07-31T11:00:00.000Z",
        }),
      ),
    ).toBe("settled");
    expect(canSettleThread(pinnedMerged)).toEqual({ canSettle: true, blocker: null });
  });

  it("blocks automatic settlement for live agent work but not for watch loops", () => {
    const pastBoundary = {
      autoSettleAfterDays: 7 as const,
      nowMs: Date.parse("2026-08-08T12:00:00.000Z"),
    };
    const working = input({ ...pastBoundary, backgroundLiveness: "working" });
    expect(classifyThreadSettlement(working)).toBe("active");
    expect(getThreadAutoSettlementBlocker(working)).toBe("background-work");
    expect(canSettleThread(working)).toEqual({ canSettle: true, blocker: null });

    const monitoring = input({ ...pastBoundary, backgroundLiveness: "monitoring" });
    expect(classifyThreadSettlement(monitoring)).toBe("settled");
    expect(getThreadAutoSettlementBlocker(monitoring)).toBeNull();
    expect(canSettleThread(monitoring)).toEqual({ canSettle: true, blocker: null });
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
          prTerminalAt: undefined,
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
          prTerminalAt: undefined,
          worktreeUpdatedAt: "invalid",
          latestTurnCompletedAt: "2026-07-31T11:20:00.000Z",
          updatedAt: "2026-07-31T11:10:00.000Z",
        }),
      ),
    ).toBe("2026-07-31T11:20:00.000Z");
  });

  it("schedules the inactivity boundary for a PR that closed before later activity", () => {
    expect(
      getNextThreadSettlementEvaluationAtMs(
        input({
          prNumber: 12,
          prState: "merged",
          prTerminalAt: "2026-07-31T09:59:30.000Z",
          autoSettleAfterDays: 7,
        }),
      ),
    ).toBe(Date.parse("2026-08-07T10:01:00.000Z"));
  });

  it("schedules the queued-turn grace end for a PR that settles while a turn is queued", () => {
    expect(
      getNextThreadSettlementEvaluationAtMs(
        input({
          prNumber: 12,
          prState: "merged",
          prTerminalAt: "2026-07-31T11:59:30.000Z",
          latestTurnRequestedAt: "2026-07-31T11:55:00.000Z",
          latestUserMessageAt: "2026-07-31T11:59:00.000Z",
          autoSettleAfterDays: 7,
        }),
      ),
    ).toBe(Date.parse("2026-07-31T12:01:00.001Z"));
  });

  it.each([
    ["pinned", { pinned: true }],
    ["working", { backgroundLiveness: "working" }],
    ["unknown PR", { prNumber: 12, prState: null }],
  ] as const)("does not schedule an evaluation for a %s thread", (_label, overrides) => {
    expect(
      getNextThreadSettlementEvaluationAtMs(input({ autoSettleAfterDays: 7, ...overrides })),
    ).toBeNull();
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
