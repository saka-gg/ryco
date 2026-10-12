import { EnvironmentId, type OrchestrationEvent, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createProjectSearchInvalidationQueue } from "./projectSearchInvalidation";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");

function event(type: string, threadId: string): OrchestrationEvent {
  return { type, payload: { threadId: ThreadId.make(threadId) } } as unknown as OrchestrationEvent;
}

function makeQueue(cwds: Record<string, string | null>) {
  const invalidate = vi.fn();
  const queue = createProjectSearchInvalidationQueue({
    resolveThreadCwd: (_environmentId, threadId) => cwds[threadId] ?? null,
    invalidate,
  });
  return { queue, invalidate };
}

describe("createProjectSearchInvalidationQueue", () => {
  it("invalidates only the checkouts of threads whose files changed", () => {
    const { queue, invalidate } = makeQueue({ a: "/repo", b: "/repo", c: "/repo/.worktrees/c" });

    queue.noteEvents(LOCAL, [
      event("thread.turn-diff-completed", "a"),
      event("thread.message-sent", "x"),
      event("thread.reverted", "b"),
    ]);
    queue.noteEvents(REMOTE, [event("thread.turn-diff-completed", "c")]);
    queue.flush();

    expect(invalidate.mock.calls).toEqual([
      [{ environmentId: LOCAL, cwd: "/repo" }],
      [{ environmentId: REMOTE, cwd: "/repo/.worktrees/c" }],
    ]);
  });

  it("falls back to the whole environment when a thread's checkout is unknown", () => {
    const { queue, invalidate } = makeQueue({ a: "/repo" });

    queue.noteEvents(LOCAL, [
      event("thread.turn-diff-completed", "a"),
      event("thread.turn-diff-completed", "unknown"),
    ]);
    queue.flush();

    expect(invalidate.mock.calls).toEqual([[{ environmentId: LOCAL }]]);
  });

  it("drains on flush and forgets pending work on reset", () => {
    const { queue, invalidate } = makeQueue({ a: "/repo" });

    queue.noteEvents(LOCAL, [event("thread.turn-diff-completed", "a")]);
    queue.flush();
    queue.flush();
    expect(invalidate).toHaveBeenCalledTimes(1);

    queue.noteEvents(LOCAL, [event("thread.turn-diff-completed", "a")]);
    queue.reset();
    queue.flush();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
