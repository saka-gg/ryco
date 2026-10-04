import { CommandId, EventId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CHECKPOINT_REVERT_PENDING_STALE_MS,
  isCheckpointRevertPending,
  latestCheckpointRevert,
  makeCheckpointRevertActivity,
  threadBusyReason,
} from "./checkpointRevertPolicy.ts";

function activity(input: {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly sequence?: number;
}): OrchestrationThreadActivity {
  return {
    ...makeCheckpointRevertActivity({
      revertRequestId: CommandId.make(input.id),
      turnCount: 1,
      status: "requested",
      createdAt: input.createdAt,
    }),
    payload: {
      schemaVersion: 1,
      revertRequestId: input.id,
      turnCount: 1,
      status: input.status,
    },
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
  };
}

describe("checkpoint revert activity", () => {
  it("builds the journal activity", () => {
    expect(
      makeCheckpointRevertActivity({
        revertRequestId: CommandId.make("cmd-1"),
        turnCount: 2,
        fromTurnCount: 4,
        status: "files-not-restored",
        reason: "files-failed",
        detail: "  detail  ",
        cwd: "/repo",
        createdAt: "2026-08-04T00:00:00.000Z",
      }),
    ).toEqual({
      id: EventId.make("checkpoint-revert:cmd-1"),
      tone: "error",
      kind: "checkpoint.revert",
      summary: "Reverted conversation; files were not restored",
      payload: {
        schemaVersion: 1,
        revertRequestId: "cmd-1",
        turnCount: 2,
        fromTurnCount: 4,
        status: "files-not-restored",
        reason: "files-failed",
        detail: "detail",
        cwd: "/repo",
      },
      turnId: null,
      createdAt: "2026-08-04T00:00:00.000Z",
    });
  });

  it("uses an info tone for pending and completed reverts", () => {
    for (const status of ["requested", "rolling-back", "restoring-files", "completed"] as const) {
      expect(
        makeCheckpointRevertActivity({
          revertRequestId: CommandId.make("cmd"),
          turnCount: 1,
          status,
          createdAt: "2026-08-04T00:00:00.000Z",
        }).tone,
      ).toBe("info");
    }
  });
});

describe("latestCheckpointRevert", () => {
  it("orders by sequence, then createdAt, then id", () => {
    const activities = [
      activity({ id: "b", status: "completed", createdAt: "2026-08-04T00:00:02.000Z" }),
      activity({ id: "a", status: "requested", createdAt: "2026-08-04T00:00:02.000Z" }),
      activity({ id: "c", status: "failed", createdAt: "2026-08-04T00:00:01.000Z" }),
    ];
    expect(latestCheckpointRevert(activities)?.payload.revertRequestId).toBe("b");
    expect(
      latestCheckpointRevert([
        ...activities,
        activity({ id: "z", status: "failed", createdAt: "2026-08-03T00:00:00.000Z", sequence: 1 }),
      ])?.payload.revertRequestId,
    ).toBe("z");
  });

  it("ignores other activity kinds", () => {
    expect(
      latestCheckpointRevert([
        {
          id: EventId.make("other"),
          tone: "info",
          kind: "checkpoint.captured",
          summary: "Checkpoint captured",
          payload: {},
          turnId: null,
          createdAt: "2026-08-04T00:00:00.000Z",
        },
      ]),
    ).toBeNull();
  });
});

describe("isCheckpointRevertPending", () => {
  const createdAt = "2026-08-04T00:00:00.000Z";
  const createdAtMs = Date.parse(createdAt);

  it("is pending until the stale cutoff", () => {
    const activities = [activity({ id: "a", status: "rolling-back", createdAt })];
    expect(isCheckpointRevertPending(activities, createdAtMs + 1_000)).toBe(true);
    expect(
      isCheckpointRevertPending(activities, createdAtMs + CHECKPOINT_REVERT_PENDING_STALE_MS - 1),
    ).toBe(true);
    expect(
      isCheckpointRevertPending(activities, createdAtMs + CHECKPOINT_REVERT_PENDING_STALE_MS),
    ).toBe(false);
  });

  it("is not pending once terminal", () => {
    expect(
      isCheckpointRevertPending(
        [activity({ id: "a", status: "interrupted", createdAt })],
        createdAtMs,
      ),
    ).toBe(false);
  });

  it("does not treat a garbage payload as pending", () => {
    expect(
      isCheckpointRevertPending(
        [{ ...activity({ id: "a", status: "requested", createdAt }), payload: { status: 1 } }],
        createdAtMs,
      ),
    ).toBe(false);
  });
});

describe("threadBusyReason", () => {
  const base = {
    threadSettlementSupported: true,
    archivedAt: null,
    deletedAt: null,
    worktreeArchivedAt: null,
    settledOverride: null,
    settledAt: null,
    sessionStatus: "ready",
    latestTurnState: "completed",
    latestTurnRequestedAt: "2026-08-04T00:00:00.000Z",
    latestTurnStartedAt: "2026-08-04T00:00:00.000Z",
    latestTurnCompletedAt: "2026-08-04T00:01:00.000Z",
    latestUserMessageAt: "2026-08-04T00:00:00.000Z",
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
    updatedAt: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    autoSettleAfterDays: null,
    nowMs: Date.parse("2026-08-04T00:10:00.000Z"),
  } as const;

  it("reports the first blocking signal", () => {
    expect(threadBusyReason(base)).toBeNull();
    expect(threadBusyReason({ ...base, sessionStatus: "starting" })).toBe("session-starting");
    expect(threadBusyReason({ ...base, latestTurnState: "running" })).toBe("session-running");
    expect(threadBusyReason({ ...base, hasPendingApprovals: true })).toBe("pending-approval");
    expect(threadBusyReason({ ...base, hasPendingUserInput: true })).toBe("pending-user-input");
    expect(threadBusyReason({ ...base, latestUserMessageAt: "2026-08-04T00:09:30.000Z" })).toBe(
      "queued-turn",
    );
  });
});
