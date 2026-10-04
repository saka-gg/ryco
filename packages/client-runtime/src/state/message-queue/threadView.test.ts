import { CheckpointRef, MessageId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeQueueAppState,
  QUEUE_ENV,
  queueRef,
  steerFailed,
  turnStartFailed,
  type ThreadFixture,
} from "../../../test/queueThreadFixtures.ts";
import type { AppState } from "../threads/store.ts";
import {
  queueThreadViewInputs,
  queueThreadViewInputsEqual,
  readQueueThreadView,
} from "./threadView.ts";

function viewOf(fixture: Omit<ThreadFixture, "id">) {
  return readQueueThreadView(makeQueueAppState([{ id: "t", ...fixture }]), queueRef("t"))!;
}

describe("readQueueThreadView", () => {
  it("is null without a shell", () => {
    expect(readQueueThreadView(makeQueueAppState([]), queueRef("missing"))).toBeNull();
  });

  it.each([
    ["a starting session", { session: { status: "starting" as const } }],
    ["an active turn id", { session: { status: "ready" as const, activeTurnId: "turn-1" } }],
    ["a running latest turn", { latestTurn: { turnId: "turn-1", state: "running" as const } }],
    ["a running session", { session: { status: "running" as const } }],
  ])("treats %s as running", (_label, fixture) => {
    expect(viewOf(fixture).running).toBe(true);
  });

  it("does not wait on a running turn row its settled session already released", () => {
    // Unfinalized turns (non-git tool-only, capture failure, ACP prompt failure)
    // stay `running` after session-set(ready|error); waiting on them is a stall
    // with no Resume.
    for (const status of ["ready", "error"] as const) {
      expect(
        viewOf({
          session: { status, updatedAt: "2026-10-01T10:00:05.000Z" },
          latestTurn: { turnId: "turn-1", state: "running" },
        }).running,
      ).toBe(false);
    }
    // A session update from before the turn started is stale ordering.
    expect(
      viewOf({
        session: { status: "ready", updatedAt: "2026-10-01T09:59:59.000Z" },
        latestTurn: { turnId: "turn-1", state: "running" },
      }).running,
    ).toBe(true);
  });

  it("is idle once the session is ready and the turn settled", () => {
    expect(
      viewOf({
        session: { status: "ready" },
        latestTurn: { turnId: "turn-1", state: "completed" },
      }).running,
    ).toBe(false);
  });

  it("reads archived from the thread or from its worktree", () => {
    expect(viewOf({ archivedAt: "2026-10-01T00:00:00.000Z" }).archived).toBe(true);
    expect(viewOf({ worktreeArchivedAt: "2026-10-01T00:00:00.000Z" }).archived).toBe(true);
    expect(viewOf({ worktreeArchivedAt: null }).archived).toBe(false);
  });

  it("ORs pending flags from the summary and the loaded activities", () => {
    expect(viewOf({ summary: { hasPendingApprovals: true } }).hasPendingApproval).toBe(true);
    expect(viewOf({ summary: { hasPendingUserInput: true } }).hasPendingUserInput).toBe(true);
    const approval = viewOf({
      messageIds: [],
      activities: [
        {
          id: "approval-1",
          kind: "approval.requested",
          payload: { requestId: "request-1", requestKind: "command" },
        },
      ],
    });
    expect(approval.hasPendingApproval).toBe(true);
    expect(approval.hasPendingUserInput).toBe(false);
  });

  it("reads start and steer failures with a message id only once detail is loaded", () => {
    const fixture = {
      activities: [
        turnStartFailed("a-1", "m-1", "Thread already has active turn"),
        steerFailed("a-2", "m-2"),
        { id: "a-3", kind: "provider.turn.start.failed", payload: { detail: "no id" } },
      ],
    };
    expect(viewOf(fixture).turnStartFailures).toEqual([]);
    const loaded = viewOf({ ...fixture, messageIds: [] });
    expect(loaded.detailLoaded).toBe(true);
    expect(loaded.turnStartFailures).toEqual([
      { activityId: "a-1", messageId: "m-1", detail: "Thread already has active turn" },
    ]);
    expect([...loaded.steerRejectionsByActivityId]).toEqual([
      ["a-2", { messageId: "m-2", reason: "failed", error: "Steer rejected." }],
    ]);
  });

  it("flags a latest turn whose checkpoint is the provider-diff placeholder", () => {
    const interrupted = { turnId: "turn-1", state: "interrupted" as const };
    const placeholder = viewOf({
      latestTurn: interrupted,
      latestCheckpoint: { status: "missing", checkpointRef: "provider-diff:event-1" },
      messageIds: [],
    });
    expect(placeholder.latestTurnPlaceholderCheckpoint).toBe(true);
    for (const latestCheckpoint of [
      { status: "missing" as const, checkpointRef: "refs/ryco/checkpoints/1" },
      { status: "ready" as const, checkpointRef: "provider-diff:event-1" },
      undefined,
    ]) {
      expect(
        viewOf({ latestTurn: interrupted, latestCheckpoint, messageIds: [] })
          .latestTurnPlaceholderCheckpoint,
      ).toBe(false);
    }
    // A checkpoint landing is a view input even when nothing else changes.
    const state = makeQueueAppState([{ id: "t", latestTurn: interrupted, messageIds: [] }]);
    const environment = state.environmentStateById[QUEUE_ENV]!;
    const captured: AppState = {
      ...state,
      environmentStateById: {
        [QUEUE_ENV]: {
          ...environment,
          turnDiffSummaryByThreadId: {
            [queueRef("t").threadId]: {
              [TurnId.make("turn-1")]: {
                turnId: TurnId.make("turn-1"),
                completedAt: "2026-10-01T10:00:02.000Z",
                status: "missing",
                files: [],
                checkpointRef: CheckpointRef.make("provider-diff:event-1"),
              },
            },
          },
        },
      },
    };
    expect(
      queueThreadViewInputsEqual(
        queueThreadViewInputs(state, queueRef("t")),
        queueThreadViewInputs(captured, queueRef("t")),
      ),
    ).toBe(false);
  });

  it("derives started from turns, projected messages, or the sidebar", () => {
    expect(viewOf({}).started).toBe(false);
    expect(viewOf({ messageIds: ["m-1"] }).started).toBe(true);
    expect(viewOf({ summary: { latestUserMessageAt: "2026-10-01T00:00:00.000Z" } }).started).toBe(
      true,
    );
    expect(viewOf({ latestTurn: { turnId: "turn-1", state: "completed" } }).started).toBe(true);
  });

  it("caches projected ids by ids-array identity across content-only updates", () => {
    const state = makeQueueAppState([{ id: "t", messageIds: ["m-1", "m-2"] }]);
    const first = readQueueThreadView(state, queueRef("t"))!;
    const environment = state.environmentStateById[QUEUE_ENV]!;
    const threadId = queueRef("t").threadId;
    // A streaming delta replaces the message record, not the ids array.
    const streamed: AppState = {
      ...state,
      environmentStateById: {
        [QUEUE_ENV]: {
          ...environment,
          messageByThreadId: {
            ...environment.messageByThreadId,
            [threadId]: { [MessageId.make("m-2")]: { text: "delta" } as never },
          },
        },
      },
    };
    const second = readQueueThreadView(streamed, queueRef("t"))!;
    expect(second.projectedMessageIds).toBe(first.projectedMessageIds);
    expect([...second.projectedMessageIds]).toEqual(["m-1", "m-2"]);
    expect(
      queueThreadViewInputsEqual(
        queueThreadViewInputs(state, queueRef("t")),
        queueThreadViewInputs(streamed, queueRef("t")),
      ),
    ).toBe(true);
  });
});
