import {
  ProviderInstanceId,
  ThreadPriorityBatchId,
  ThreadPriorityFingerprint,
  ThreadPriorityReason,
  TurnId,
  type ThreadPriorityProjectedRanking,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeThreadPriorityFocus,
  isFreshLatestFailure,
  isUsableThreadPriorityRanking,
  partitionThreadPriorities,
  THREAD_PRIORITY_MAX_AGE_MS,
  type ThreadPriorityPartitionCandidate,
} from "./threadPriority.ts";

const nowMs = Date.parse("2026-08-25T12:00:00.000Z");

function ranking(
  tier: ThreadPriorityProjectedRanking["tier"],
  confidence: ThreadPriorityProjectedRanking["confidence"] = "high",
  overrides: Partial<ThreadPriorityProjectedRanking> = {},
): ThreadPriorityProjectedRanking {
  return {
    tier,
    confidence,
    reason: ThreadPriorityReason.make("Actionable next work"),
    inputFingerprint: ThreadPriorityFingerprint.make("input-fingerprint"),
    batchId: ThreadPriorityBatchId.make("batch-1"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    rankedAt: new Date(nowMs - 60_000).toISOString(),
    usableUntil: new Date(nowMs + THREAD_PRIORITY_MAX_AGE_MS - 60_000).toISOString(),
    ...overrides,
  };
}

function candidate(
  scopedKey: string,
  overrides: Partial<ThreadPriorityPartitionCandidate> = {},
): ThreadPriorityPartitionCandidate {
  return {
    scopedKey,
    pinned: false,
    serverOwned: true,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    latestUserMessageAt: null,
    ...overrides,
  };
}

function failedAt(value: string) {
  return {
    turnId: TurnId.make("turn-failed"),
    state: "error" as const,
    requestedAt: value,
    startedAt: value,
    completedAt: value,
    assistantMessageId: null,
  };
}

describe("thread priority partition", () => {
  it("uses the shared transparent reason vocabulary", () => {
    expect(describeThreadPriorityFocus({ source: "approval", ranking: null })).toEqual({
      title: "Approval required",
      detail: "This thread is waiting for your approval.",
      aiGenerated: false,
    });
    expect(describeThreadPriorityFocus({ source: "ai", ranking: ranking("now") })).toEqual({
      title: "Now",
      detail: "Actionable next work",
      aiGenerated: true,
    });
  });

  it("returns the exact active ordering when disabled", () => {
    const active = [candidate("env-a:one"), candidate("env-b:two")];
    const partition = partitionThreadPriorities({
      active,
      enabled: false,
      nowMs,
      toCandidate: (value) => value,
    });
    expect(partition.active).toBe(active);
    expect(partition.focus).toEqual([]);
  });

  it("keeps Focus and Active lossless and duplicate-free across five environments", () => {
    const active = Array.from({ length: 5 }, (_, index) =>
      candidate(`environment-${index}:shared-thread-id`, {
        priority: ranking(index < 2 ? "now" : index < 4 ? "soon" : "later"),
      }),
    );
    const partition = partitionThreadPriorities({
      active,
      enabled: true,
      nowMs,
      toCandidate: (value) => value,
    });
    const keys = [
      ...partition.focus.map((entry) => entry.value.scopedKey),
      ...partition.active.map((entry) => entry.scopedKey),
    ];
    expect(new Set(keys).size).toBe(active.length);
    expect(keys.toSorted()).toEqual(active.map((entry) => entry.scopedKey).toSorted());
    expect(partition.focus).toHaveLength(4);
  });

  it("preserves every pin before deterministic and AI entries", () => {
    const active = [
      ...Array.from({ length: 6 }, (_, index) => candidate(`env:pin-${index}`, { pinned: true })),
      candidate("env:approval", { hasPendingApprovals: true }),
      candidate("env:ai", { priority: ranking("now") }),
    ];
    const partition = partitionThreadPriorities({
      active,
      enabled: true,
      nowMs,
      toCandidate: (value) => value,
    });
    expect(partition.focus).toHaveLength(6);
    expect(partition.focus.every((entry) => entry.focus.source === "pin")).toBe(true);
    expect(partition.active.map((entry) => entry.scopedKey)).toEqual(["env:approval", "env:ai"]);
  });

  it("orders approval, input, and a fresh failure before AI", () => {
    const failed = new Date(nowMs - 60_000).toISOString();
    const active = [
      candidate("env:ai-now", { priority: ranking("now") }),
      candidate("env:failure", { latestTurn: failedAt(failed) }),
      candidate("env:input", { hasPendingUserInput: true }),
      candidate("env:approval", { hasPendingApprovals: true }),
      candidate("env:ai-soon", { priority: ranking("soon") }),
    ];
    const partition = partitionThreadPriorities({
      active,
      enabled: true,
      nowMs,
      toCandidate: (value) => value,
    });
    expect(partition.focus.map((entry) => [entry.value.scopedKey, entry.focus.source])).toEqual([
      ["env:approval", "approval"],
      ["env:input", "input"],
      ["env:failure", "failure"],
      ["env:ai-now", "ai"],
      ["env:ai-soon", "ai"],
    ]);
  });

  it("drops deterministic failure promotion after a newer user turn or 24 hours", () => {
    const failed = new Date(nowMs - 60_000).toISOString();
    expect(
      isFreshLatestFailure(
        { latestTurn: failedAt(failed), latestUserMessageAt: new Date(nowMs).toISOString() },
        nowMs,
      ),
    ).toBe(false);
    const expired = new Date(nowMs - THREAD_PRIORITY_MAX_AGE_MS).toISOString();
    expect(
      isFreshLatestFailure({ latestTurn: failedAt(expired), latestUserMessageAt: null }, nowMs),
    ).toBe(false);
  });

  it("accepts only current high or medium Now and Soon rankings", () => {
    const cases = [
      [ranking("now"), true],
      [ranking("soon", "medium"), true],
      [ranking("later"), false],
      [ranking("none"), false],
      [ranking("now", "low"), false],
      [
        ranking("now", "high", {
          rankedAt: new Date(nowMs - THREAD_PRIORITY_MAX_AGE_MS).toISOString(),
        }),
        false,
      ],
      [ranking("now", "high", { usableUntil: new Date(nowMs).toISOString() }), false],
    ] as const;
    expect(cases.map(([value]) => isUsableThreadPriorityRanking(value, nowMs))).toEqual(
      cases.map(([, expected]) => expected),
    );
  });

  it("keeps stable input order for equal AI tiers and excludes client drafts", () => {
    const active = [
      candidate("env:first", { priority: ranking("soon") }),
      candidate("env:draft", { pinned: true, serverOwned: false, priority: ranking("now") }),
      candidate("env:second", { priority: ranking("soon") }),
    ];
    const partition = partitionThreadPriorities({
      active,
      enabled: true,
      nowMs,
      toCandidate: (value) => value,
    });
    expect(partition.focus.map((entry) => entry.value.scopedKey)).toEqual([
      "env:first",
      "env:second",
    ]);
    expect(partition.active.map((entry) => entry.scopedKey)).toEqual(["env:draft"]);
  });
});
