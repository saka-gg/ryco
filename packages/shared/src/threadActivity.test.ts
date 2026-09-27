import { describe, expect, it } from "vite-plus/test";
import { EventId } from "@ryco/contracts";
import {
  capThreadActivitiesPreservingMilestones,
  derivePendingThreadRequestState,
  derivePendingThreadRequests,
  isContextCompactionActivity,
  isTerminalContextHandoffActivity,
  isThreadActivityMilestone,
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
