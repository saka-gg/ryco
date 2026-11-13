import type { OrchestrationThreadActivity } from "@ryco/contracts/orchestration";
import { describe, expect, it } from "vite-plus/test";

type Activity = Pick<OrchestrationThreadActivity, "id" | "kind" | "payload">;

import { capThreadActivitiesPreservingMilestones } from "./threadActivity.ts";
import {
  isCheckpointBeforeThreadMove,
  isTurnDiffBeforeThreadMove,
  latestThreadMove,
  threadMoveCheckpointFloor,
  threadProjectMoveBlocker,
  threadProjectMoveBlockerMessage,
} from "./threadMove.ts";

const moved = (id: string, checkpointTurnCount: number, toProjectId = "beta"): Activity => ({
  id: id as Activity["id"],
  kind: "thread.moved",
  payload: {
    schemaVersion: 1,
    fromProjectId: "alpha",
    fromProjectTitle: "Alpha",
    toProjectId,
    toProjectTitle: "Beta",
    fromWorktreePath: null,
    checkpointTurnCount,
  },
});

describe("thread move records", () => {
  it("reads the newest move's checkpoint floor", () => {
    expect(threadMoveCheckpointFloor([])).toBeNull();
    const activities = [
      moved("first", 2),
      { id: "tool" as Activity["id"], kind: "tool.completed", payload: {} },
      moved("second", 5, "gamma"),
    ];
    expect(latestThreadMove(activities)?.toProjectId).toBe("gamma");
    expect(threadMoveCheckpointFloor(activities)).toBe(5);
    // An unreadable record is skipped, not trusted.
    expect(
      threadMoveCheckpointFloor([
        moved("ok", 3),
        { id: "bad" as Activity["id"], kind: "thread.moved", payload: {} },
      ]),
    ).toBe(3);
  });

  it("separates checkpoints captured before the move from those after it", () => {
    expect(isCheckpointBeforeThreadMove(1, 2)).toBe(true);
    expect(isCheckpointBeforeThreadMove(2, 2)).toBe(false);
    expect(isCheckpointBeforeThreadMove(0, null)).toBe(false);
    expect(isTurnDiffBeforeThreadMove(2, 2)).toBe(true);
    expect(isTurnDiffBeforeThreadMove(3, 2)).toBe(false);
  });

  it("keeps the move record when the activity cap drops older activities", () => {
    const activities = [
      moved("move", 1),
      ...Array.from({ length: 5 }, (_, index): Activity => ({
        id: `tool-${index}` as Activity["id"],
        kind: "tool.completed",
        payload: {},
      })),
    ];
    const capped = capThreadActivitiesPreservingMilestones(activities, 2);
    expect(capped.map((activity) => activity.id)).toEqual(["move", "tool-3", "tool-4"]);
  });
});

describe("threadProjectMoveBlocker", () => {
  const idle = {
    archived: false,
    deleted: false,
    sessionStatus: "ready",
    latestTurnRunning: false,
    backgroundWorking: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    queuedTurn: false,
    contextHandoffPending: false,
    checkpointRevertPending: false,
  };

  it("names the first reason in a fixed order", () => {
    expect(threadProjectMoveBlocker(idle)).toBeNull();
    expect(
      threadProjectMoveBlocker({ ...idle, sessionStatus: "running", hasPendingApprovals: true }),
    ).toBe("session-running");
    expect(threadProjectMoveBlocker({ ...idle, queuedTurn: true })).toBe("queued-turn");
    expect(threadProjectMoveBlocker({ ...idle, contextHandoffPending: true })).toBe(
      "context-handoff",
    );
    expect(threadProjectMoveBlockerMessage("checkpoint-revert")).toBe(
      "Wait for the revert to finish",
    );
  });
});
