import { describe, expect, it } from "vite-plus/test";
import { EventId } from "@ryco/contracts";
import {
  capThreadActivitiesPreservingMilestones,
  CHANGED_FILE_SCAN_MAX_FILES,
  collectChangedFiles,
  compareThreadActivities,
  compareThreadActivitiesInLifecycleOrder,
  compareThreadActivitySequence,
  derivePendingThreadRequestState,
  derivePendingThreadRequests,
  isContextCompactionActivity,
  isTerminalContextHandoffActivity,
  isThreadActivityMilestone,
  resolveRevertRetention,
  retainThreadMessagesAfterForkRevert,
  retainThreadMessagesAfterRevert,
  retainTurnItemsAfterRevert,
} from "./threadActivity.ts";

function activity(id: string, kind = "tool.completed", payload: unknown = {}) {
  return {
    id: EventId.make(id),
    kind,
    payload,
  };
}

function handoffPayload(status: "consumed" | "failed" | "delivery-uncertain") {
  return {
    schemaVersion: 1,
    handoffId: "handoff-1",
    mode: "full-context-fresh-session",
    targetMessageId: "message-2",
    sourceSelection: { instanceId: "codex_work", model: "gpt-5.6" },
    targetSelection: { instanceId: "claude_work", model: "claude-fable-5" },
    sources: [
      {
        providerInstanceId: "codex_work",
        driverKind: "codex",
        modelSlug: "gpt-5.6",
      },
    ],
    target: {
      providerInstanceId: "claude_work",
      driverKind: "claudeAgent",
      modelSlug: "claude-fable-5",
    },
    ...(status === "failed" ? {} : { contextVersion: 1, contextDigest: "a".repeat(64) }),
    status,
    ...(status === "failed" || status === "delivery-uncertain"
      ? { error: "Target delivery failed" }
      : {}),
  };
}

function forkedPayload(providerContext: "native" | "handoff") {
  return {
    schemaVersion: 1,
    sourceThreadId: "thread-source",
    sourceMessageId: "message-source",
    sourceTurnId: "turn-source",
    sourceTitle: "Source",
    inheritedMessageCount: 2,
    providerContext,
    ...(providerContext === "handoff" ? { handoffReason: "provider-unsupported" } : {}),
    checkout: { kind: "current-checkout", worktreePath: null, branch: null },
    notices: [],
  };
}

describe("threadActivity", () => {
  it("identifies context compaction activities", () => {
    expect(isContextCompactionActivity(activity("compaction", "context-compaction"))).toBe(true);
    expect(isContextCompactionActivity(activity("tool"))).toBe(false);
  });

  it("identifies only terminal, schema-valid context handoffs as milestones", () => {
    expect(
      isTerminalContextHandoffActivity(
        activity("handoff", "context-handoff", handoffPayload("consumed")),
      ),
    ).toBe(true);
    expect(
      isTerminalContextHandoffActivity(
        activity("pending", "context-handoff", {
          ...handoffPayload("consumed"),
          status: "preparing",
        }),
      ),
    ).toBe(false);
    expect(isTerminalContextHandoffActivity(activity("malformed", "context-handoff"))).toBe(false);
    expect(
      isThreadActivityMilestone(
        activity("uncertain", "context-handoff", handoffPayload("delivery-uncertain")),
      ),
    ).toBe(true);
  });

  it("caps recent activities while preserving older context compaction milestones", () => {
    const result = capThreadActivitiesPreservingMilestones(
      [
        activity("old-tool-1"),
        activity("old-compaction", "context-compaction"),
        activity("old-tool-2"),
        activity("recent-tool-1"),
        activity("recent-tool-2"),
      ],
      2,
    );

    expect(result.map((entry) => entry.id)).toEqual([
      "old-compaction",
      "recent-tool-1",
      "recent-tool-2",
    ]);
  });

  it("preserves older terminal handoffs alongside compaction milestones", () => {
    const result = capThreadActivitiesPreservingMilestones(
      [
        activity("old-handoff", "context-handoff", handoffPayload("consumed")),
        activity("old-pending", "context-handoff", {
          ...handoffPayload("consumed"),
          status: "dispatching",
        }),
        activity("old-compaction", "context-compaction"),
        activity("recent-tool-1"),
        activity("recent-tool-2"),
      ],
      2,
    );

    expect(result.map((entry) => entry.id)).toEqual([
      "old-handoff",
      "old-compaction",
      "recent-tool-1",
      "recent-tool-2",
    ]);
  });

  it("keeps the fork provenance activity under the cap", () => {
    const result = capThreadActivitiesPreservingMilestones(
      [
        activity("inherited-tool"),
        activity("forked", "thread.forked", forkedPayload("handoff")),
        activity("recent-tool-1"),
        activity("recent-tool-2"),
      ],
      2,
    );

    expect(result.map((entry) => entry.id)).toEqual(["forked", "recent-tool-1", "recent-tool-2"]);
    // Kind alone: an unreadable record still keeps its timeline position.
    expect(isThreadActivityMilestone(activity("forked", "thread.forked", null))).toBe(true);
  });

  it("derives pending approval and user-input request state in activity order", () => {
    const requestActivity = (
      id: string,
      kind: string,
      requestId: string,
      createdAt: string,
      detail?: string,
    ) => ({
      id: EventId.make(id),
      kind,
      createdAt,
      payload: {
        requestId,
        ...(detail ? { detail } : {}),
      },
    });

    expect(
      derivePendingThreadRequestState([
        requestActivity(
          "approval-open",
          "approval.requested",
          "approval-1",
          "2026-01-01T00:00:00Z",
        ),
        requestActivity("input-open", "user-input.requested", "input-1", "2026-01-01T00:00:01Z"),
        requestActivity(
          "approval-stale",
          "provider.approval.respond.failed",
          "approval-1",
          "2026-01-01T00:00:02Z",
          "Unknown pending approval request",
        ),
        requestActivity("input-resolved", "user-input.resolved", "input-1", "2026-01-01T00:00:03Z"),
        requestActivity(
          "approval-open-2",
          "approval.requested",
          "approval-2",
          "2026-01-01T00:00:04Z",
        ),
      ]),
    ).toEqual({
      pendingApprovalCount: 1,
      pendingUserInputCount: 0,
      hasPendingApprovals: true,
      hasPendingUserInput: false,
    });
  });
});

it("keeps pending request ownership by turn and applies resolution in sequence order", () => {
  expect(
    derivePendingThreadRequests([
      {
        kind: "user-input.resolved",
        payload: { requestId: "old" },
        turnId: "old-turn",
        sequence: 3,
        createdAt: "2026-01-01",
      },
      {
        kind: "user-input.requested",
        payload: { requestId: "old" },
        turnId: "old-turn",
        sequence: 1,
        createdAt: "2026-01-01",
      },
      {
        kind: "approval.requested",
        payload: { requestId: "new" },
        turnId: "new-turn",
        sequence: 2,
        createdAt: "2026-01-01",
      },
    ]),
  ).toEqual([{ kind: "approval", requestId: "new", turnId: "new-turn" }]);
});

it("counts optional questions for invalidation but never as blocking input", () => {
  const activities = [
    {
      id: "q",
      createdAt: "2026-09-27T00:00:00.000Z",
      kind: "user-input.requested",
      turnId: "turn",
      payload: { requestId: "optional", nonBlocking: true },
    },
  ];
  expect(derivePendingThreadRequestState(activities).hasPendingUserInput).toBe(false);
  expect(derivePendingThreadRequests(activities)).toEqual([
    { requestId: "optional", turnId: "turn", kind: "user-input", nonBlocking: true },
  ]);
});

describe("activity order", () => {
  const entry = (id: string, createdAt: string, sequence?: number) => ({ id, createdAt, sequence });

  it("sorts sequenced activities after unsequenced ones, then by sequence", () => {
    expect(compareThreadActivitySequence({ sequence: 2 }, { sequence: undefined })).toBe(1);
    expect(compareThreadActivitySequence({ sequence: undefined }, { sequence: 2 })).toBe(-1);
    expect(compareThreadActivitySequence({ sequence: 1 }, { sequence: 3 })).toBe(-2);
    expect(compareThreadActivitySequence({ sequence: 3 }, { sequence: 3 })).toBe(0);
    expect(compareThreadActivitySequence({}, {})).toBe(0);
  });

  it("falls back to creation time, then id, when sequences tie or are missing", () => {
    const ordered = [
      entry("c", "2026-01-01T00:00:03.000Z", 5),
      entry("b", "2026-01-01T00:00:02.000Z"),
      entry("a", "2026-01-01T00:00:09.000Z", 4),
      entry("z", "2026-01-01T00:00:01.000Z"),
      entry("y", "2026-01-01T00:00:01.000Z"),
    ].toSorted(compareThreadActivities);

    expect(ordered.map((value) => value.id)).toEqual(["y", "z", "b", "a", "c"]);
    expect(
      compareThreadActivities(
        entry("a", "2026-01-01T00:00:05.000Z", 7),
        entry("b", "2026-01-01T00:00:01.000Z", 7),
      ),
    ).toBeGreaterThan(0);
  });

  it("orders a lifecycle recorded in the same instant before the id decides", () => {
    const at = "2026-01-01T00:00:01.000Z";
    const lifecycle = (id: string, kind: string, sequence?: number) => ({
      ...entry(id, at, sequence),
      kind,
    });
    const ordered = [
      lifecycle("a", "user-input.resolved"),
      lifecycle("b", "tool.completed"),
      lifecycle("c", "tool.updated"),
      lifecycle("d", "user-input.requested"),
      lifecycle("e", "tool.started"),
    ].toSorted(compareThreadActivitiesInLifecycleOrder);

    expect(ordered.map((value) => value.id)).toEqual(["e", "c", "d", "a", "b"]);
    // The sequence still decides first.
    expect(
      compareThreadActivitiesInLifecycleOrder(
        lifecycle("a", "user-input.resolved", 1),
        lifecycle("b", "user-input.requested", 2),
      ),
    ).toBeLessThan(0);
  });
});

describe("collectChangedFiles", () => {
  const collect = (value: unknown) => {
    const files: string[] = [];
    collectChangedFiles(value, files, new Set<string>(), 0);
    return files;
  };

  it("collects trimmed, distinct paths from every path key and nested record", () => {
    expect(
      collect({
        path: " src/a.ts ",
        filePath: "src/a.ts",
        relativePath: "src/b.ts",
        filename: "c.ts",
        newPath: "",
        oldPath: 4,
        item: { changes: [{ path: "src/d.ts" }, { path: "src/b.ts" }] },
        result: { files: [{ newPath: "src/e.ts", oldPath: "src/f.ts" }] },
      }),
    ).toEqual(["src/a.ts", "src/b.ts", "c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]);
  });

  it("ignores values that are not records or arrays of records", () => {
    expect(collect(null)).toEqual([]);
    expect(collect("src/a.ts")).toEqual([]);
    expect(collect([{ path: "src/a.ts" }, "src/b.ts"])).toEqual(["src/a.ts"]);
  });

  it("stops at the nesting depth and at the file limit", () => {
    expect(collect({ data: { data: { data: { data: { path: "deep.ts" } } } } })).toEqual([
      "deep.ts",
    ]);
    expect(
      collect({ data: { data: { data: { data: { data: { path: "deeper.ts" } } } } } }),
    ).toEqual([]);

    const many = Array.from({ length: CHANGED_FILE_SCAN_MAX_FILES + 5 }, (_, index) => ({
      path: `src/${index}.ts`,
    }));
    expect(collect({ changes: many })).toHaveLength(CHANGED_FILE_SCAN_MAX_FILES);
  });
});

describe("checkpoint revert retention", () => {
  const t = (minute: number) => `2026-02-23T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const message = (
    id: string,
    role: "user" | "assistant" | "system",
    turnId: string | null | undefined,
    minute: number,
  ) => ({ id, role, turnId, createdAt: t(minute) });
  const item = (id: string, turnId: string | null, minute: number) => ({
    id,
    turnId,
    createdAt: t(minute),
  });
  const latestTurn5 = { turnId: "turn-5", completedAt: t(5) };
  const ids = (values: ReadonlyArray<{ readonly id: string }>) => values.map((value) => value.id);

  describe("resolveRevertRetention", () => {
    it("keeps only checkpointed turns until an authoritative latest turn is known", () => {
      const { keepTurnItem, boundaryAt } = resolveRevertRetention({
        retainedTurnIds: ["turn-1"],
      });
      expect(boundaryAt).toBeUndefined();
      expect(keepTurnItem({ turnId: "turn-1", createdAt: t(1) })).toBe(true);
      expect(keepTurnItem({ turnId: "turn-3", createdAt: t(3) })).toBe(false);
    });

    it("keeps undropped turns up to the authoritative boundary", () => {
      const { keepTurnItem, boundaryAt } = resolveRevertRetention({
        retainedTurnIds: [],
        latestTurn: latestTurn5,
        droppedTurnIds: ["turn-7", "turn-4"],
      });
      expect(boundaryAt).toBe(t(5));
      // The latest turn itself, whatever its items' timestamps.
      expect(keepTurnItem({ turnId: "turn-5", createdAt: t(8) })).toBe(true);
      expect(keepTurnItem({ turnId: "turn-3", createdAt: t(3) })).toBe(true);
      expect(keepTurnItem({ turnId: "turn-3", createdAt: t(6) })).toBe(false);
      expect(keepTurnItem({ turnId: "turn-4", createdAt: t(4) })).toBe(false);
    });

    it("keeps nothing beyond the checkpoints when the revert leaves no latest turn", () => {
      const { keepTurnItem, boundaryAt } = resolveRevertRetention({
        retainedTurnIds: ["turn-1"],
        latestTurn: null,
        droppedTurnIds: ["turn-2"],
      });
      expect(boundaryAt).toBeNull();
      expect(keepTurnItem({ turnId: "turn-1", createdAt: t(1) })).toBe(true);
      expect(keepTurnItem({ turnId: "turn-3", createdAt: t(0) })).toBe(false);
    });

    it("does not mutate the retained turn ids it is given", () => {
      const retainedTurnIds = new Set(["turn-1"]);
      const { keepTurnItem } = resolveRevertRetention({ retainedTurnIds, latestTurn: latestTurn5 });
      expect(retainedTurnIds.has("turn-5")).toBe(false);
      expect(keepTurnItem({ turnId: "turn-5", createdAt: t(5) })).toBe(true);
    });
  });

  describe("retainThreadMessagesAfterRevert", () => {
    // A hydrated command model: turn-less user prompts and no checkpoints.
    const hydrated = [
      message("user-anchor-1", "user", null, 1),
      message("user-anchor-9", "user", null, 9),
    ];

    it("fills the missing prompts by count when no boundary applies", () => {
      const { keepTurnItem } = resolveRevertRetention({ retainedTurnIds: [] });
      expect(ids(retainThreadMessagesAfterRevert(hydrated, keepTurnItem, 5, undefined))).toEqual([
        "user-anchor-1",
        "user-anchor-9",
      ]);
      expect(ids(retainThreadMessagesAfterRevert(hydrated, keepTurnItem, 1, undefined))).toEqual([
        "user-anchor-1",
      ]);
    });

    it("never fills the count fallback past the authoritative boundary", () => {
      const { keepTurnItem, boundaryAt } = resolveRevertRetention({
        retainedTurnIds: [],
        latestTurn: latestTurn5,
        droppedTurnIds: ["turn-6", "turn-7", "turn-8", "turn-9"],
      });
      expect(ids(retainThreadMessagesAfterRevert(hydrated, keepTurnItem, 5, boundaryAt))).toEqual([
        "user-anchor-1",
      ]);
    });

    it("keeps no fallback candidates when the revert leaves no latest turn", () => {
      const { keepTurnItem, boundaryAt } = resolveRevertRetention({
        retainedTurnIds: [],
        latestTurn: null,
      });
      expect(boundaryAt).toBeNull();
      expect(ids(retainThreadMessagesAfterRevert(hydrated, keepTurnItem, 5, boundaryAt))).toEqual(
        [],
      );
    });

    it("keeps system messages and messages of kept turns, and fills each role by its own count", () => {
      const messages = [
        message("system-1", "system", "turn-9", 0),
        message("user-1", "user", "turn-1", 1),
        message("assistant-1", "assistant", "turn-1", 2),
        message("user-2", "user", "turn-2", 3),
        message("assistant-2", "assistant", undefined, 4),
        message("assistant-3", "assistant", null, 5),
      ];
      const { keepTurnItem } = resolveRevertRetention({ retainedTurnIds: ["turn-1"] });
      expect(ids(retainThreadMessagesAfterRevert(messages, keepTurnItem, 2))).toEqual([
        "system-1",
        "user-1",
        "assistant-1",
        "assistant-2",
      ]);
    });

    it("orders fallback candidates by creation time, then id", () => {
      const messages = [
        message("user-b", "user", null, 3),
        message("user-a", "user", null, 3),
        message("user-early", "user", null, 1),
      ];
      const { keepTurnItem } = resolveRevertRetention({ retainedTurnIds: [] });
      expect(ids(retainThreadMessagesAfterRevert(messages, keepTurnItem, 2))).toEqual([
        "user-a",
        "user-early",
      ]);
    });
  });

  describe("retainThreadMessagesAfterForkRevert", () => {
    const forkId = "fork-1";
    const inherited = (id: string) => `${forkId}:inherited:${id}`;
    const messages = [
      message(inherited("user-0"), "user", null, 1),
      message(inherited("assistant-0"), "assistant", "turn-source", 2),
      message("user-1", "user", null, 10),
      message("assistant-1", "assistant", "turn-1", 12),
      message("user-2", "user", null, 20),
      message("assistant-2", "assistant", "turn-2", 22),
    ];

    it("keeps inherited history without letting it fill the own count fallback", () => {
      const { keepTurnItem } = resolveRevertRetention({ retainedTurnIds: ["turn-1"] });
      expect(ids(retainThreadMessagesAfterForkRevert(forkId, messages, keepTurnItem, 1))).toEqual([
        inherited("user-0"),
        inherited("assistant-0"),
        "user-1",
        "assistant-1",
      ]);
    });

    it("keeps only the inherited history when reverting to the fork's start", () => {
      for (const resolved of [
        resolveRevertRetention({ retainedTurnIds: [] }),
        resolveRevertRetention({
          retainedTurnIds: [],
          latestTurn: null,
          droppedTurnIds: ["turn-1", "turn-2"],
        }),
      ]) {
        expect(
          ids(
            retainThreadMessagesAfterForkRevert(
              forkId,
              messages,
              resolved.keepTurnItem,
              0,
              resolved.boundaryAt,
            ),
          ),
        ).toEqual([inherited("user-0"), inherited("assistant-0")]);
      }
    });
  });

  describe("retainTurnItemsAfterRevert", () => {
    const forkId = "fork-1";
    const plans = [
      item("plan-3", "turn-3", 3),
      item("plan-9", "turn-9", 9),
      item("plan-none", null, 9),
      item(`${forkId}:inherited:plan-0`, "turn-source", 0),
      item(`${forkId}:forked`, "turn-source", 0),
    ];

    it("keeps turn-less items, fork history and items of kept turns", () => {
      const { keepTurnItem } = resolveRevertRetention({
        retainedTurnIds: [],
        latestTurn: latestTurn5,
        droppedTurnIds: ["turn-9"],
      });
      expect(ids(retainTurnItemsAfterRevert(forkId, plans, keepTurnItem))).toEqual([
        "plan-3",
        "plan-none",
        `${forkId}:inherited:plan-0`,
        `${forkId}:forked`,
      ]);
    });

    it("drops every turn-bound item of an unrelated thread that is not retained", () => {
      const { keepTurnItem } = resolveRevertRetention({ retainedTurnIds: ["turn-3"] });
      expect(ids(retainTurnItemsAfterRevert("other-thread", plans, keepTurnItem))).toEqual([
        "plan-3",
        "plan-none",
      ]);
    });
  });
});
