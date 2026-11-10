import { EnvironmentId, type OrchestrationEvent, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveOrchestrationBatchEffects } from "./orchestrationEventEffects.ts";
import { createWorkspaceChangeQueue } from "./workspaceChangeQueue.ts";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");

function event(type: string, threadId: string, payload: object = {}): OrchestrationEvent {
  return {
    type,
    payload: { threadId: ThreadId.make(threadId), ...payload },
  } as unknown as OrchestrationEvent;
}

const turnDiff = (threadId: string, checkpointTurnCount: number) =>
  event("thread.turn-diff-completed", threadId, { checkpointTurnCount });

function makeQueue(cwds: Record<string, string | null>) {
  const invalidateCheckout = vi.fn();
  const invalidateCheckpointDiffs = vi.fn();
  const queue = createWorkspaceChangeQueue({
    resolveThreadCwd: (_environmentId, threadId) => cwds[threadId] ?? null,
    invalidateCheckout,
    invalidateCheckpointDiffs,
  });
  const note = (environmentId: EnvironmentId, events: ReadonlyArray<OrchestrationEvent>) =>
    queue.note(environmentId, deriveOrchestrationBatchEffects(events));
  return { queue, note, invalidateCheckout, invalidateCheckpointDiffs };
}

describe("createWorkspaceChangeQueue", () => {
  it("invalidates only the checkouts of threads whose files changed", () => {
    const { queue, note, invalidateCheckout } = makeQueue({
      a: "/repo",
      b: "/repo",
      c: "/repo/.worktrees/c",
    });

    note(LOCAL, [
      turnDiff("a", 2),
      event("thread.message-sent", "x"),
      event("thread.reverted", "b", { turnCount: 1 }),
    ]);
    note(REMOTE, [turnDiff("c", 1)]);
    queue.flush();

    expect(invalidateCheckout.mock.calls).toEqual([
      [LOCAL, "/repo"],
      [REMOTE, "/repo/.worktrees/c"],
    ]);
  });

  it("names only the diff ranges a turn or a revert changed", () => {
    const { queue, note, invalidateCheckpointDiffs } = makeQueue({ a: "/repo", b: "/repo" });

    note(LOCAL, [turnDiff("a", 4), turnDiff("a", 3), event("thread.reverted", "b")]);
    note(LOCAL, [turnDiff("b", 2)]);
    queue.flush();

    expect(invalidateCheckpointDiffs.mock.calls).toEqual([
      [
        [
          { threadId: ThreadId.make("a"), fromTurnCount: 3 },
          { threadId: ThreadId.make("b"), fromTurnCount: null },
        ],
      ],
    ]);
  });

  it("invalidates the checkout a files-only revert restored, once it ends, and no diffs", () => {
    const { queue, note, invalidateCheckout, invalidateCheckpointDiffs } = makeQueue({
      a: "/repo",
    });
    const revertRow = (status: string, rollbackConversation?: false) =>
      ({
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("a"),
          activity: {
            kind: "checkpoint.revert",
            payload: {
              status,
              ...(rollbackConversation === false ? { rollbackConversation } : {}),
            },
          },
        },
      }) as unknown as OrchestrationEvent;

    note(LOCAL, [revertRow("restoring-files", false), revertRow("completed")]);
    queue.flush();
    expect(invalidateCheckout).not.toHaveBeenCalled();

    note(LOCAL, [revertRow("completed", false)]);
    queue.flush();
    expect(invalidateCheckout.mock.calls).toEqual([[LOCAL, "/repo"]]);
    expect(invalidateCheckpointDiffs).not.toHaveBeenCalled();
  });

  it("falls back to the whole environment when a thread's checkout is unknown", () => {
    const { queue, note, invalidateCheckout } = makeQueue({ a: "/repo" });

    note(LOCAL, [turnDiff("a", 1), turnDiff("unknown", 1)]);
    queue.flush();

    expect(invalidateCheckout.mock.calls).toEqual([[LOCAL, null]]);
  });

  it("drains on flush and forgets pending work on reset", () => {
    const { queue, note, invalidateCheckout } = makeQueue({ a: "/repo" });

    note(LOCAL, [turnDiff("a", 1)]);
    queue.flush();
    queue.flush();
    expect(invalidateCheckout).toHaveBeenCalledTimes(1);

    note(LOCAL, [turnDiff("a", 2)]);
    queue.reset();
    queue.flush();
    expect(invalidateCheckout).toHaveBeenCalledTimes(1);
  });
});
