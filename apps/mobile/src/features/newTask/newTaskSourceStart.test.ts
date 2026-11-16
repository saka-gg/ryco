import { describe, expect, it, vi } from "vite-plus/test";

import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@ryco/contracts";

import { createNewTaskAttempt } from "./newTaskController";
import { newTaskSourceAttempt, startNewTaskFromSource } from "./newTaskSourceStart";

const draftThreadId = ThreadId.make("thread-source");
const nodeThreadId = ThreadId.make("thread-node");

const baseAttempt = createNewTaskAttempt({
  environmentId: EnvironmentId.make("environment"),
  prompt: "Review the pull request",
  project: {
    kind: "existing",
    projectId: ProjectId.make("project"),
    workspaceRoot: "/code/ryco",
  },
  worktree: { kind: "local" },
  createdAt: "2026-11-16T09:00:00.000Z",
  ids: {
    projectId: ProjectId.make("project-new"),
    projectCommandId: CommandId.make("command-project"),
    threadId: draftThreadId,
    threadCommandId: CommandId.make("command-thread"),
    attachCommandId: CommandId.make("command-attach"),
    turnCommandId: CommandId.make("command-turn"),
    messageId: MessageId.make("message"),
  },
});

describe("New Task from a source", () => {
  it("launches the task into the thread the node made", async () => {
    const launch = vi.fn();
    const onFailure = vi.fn();

    const attempt = await startNewTaskFromSource({
      attempt: baseAttempt,
      createWorktree: async () => ({ sessionId: nodeThreadId }),
      launch,
      onFailure,
    });

    expect(attempt).toEqual(newTaskSourceAttempt(baseAttempt, nodeThreadId));
    expect(attempt).toMatchObject({
      threadId: nodeThreadId,
      ids: { threadId: nodeThreadId, turnCommandId: CommandId.make("command-turn") },
      worktree: { kind: "local" },
      threadCommandAccepted: true,
      threadReady: true,
      worktreeAttached: true,
      threadSettingsPending: true,
    });
    expect(launch).toHaveBeenCalledWith(attempt);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a refused worktree without launching", async () => {
    const launch = vi.fn();
    const onFailure = vi.fn();
    const refused = new Error("The pull request is closed.");

    const attempt = await startNewTaskFromSource({
      attempt: baseAttempt,
      createWorktree: async () => {
        throw refused;
      },
      launch,
      onFailure,
    });

    expect(attempt).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(refused);
  });

  it("reports a launch that throws after the node made the worktree", async () => {
    const onFailure = vi.fn();
    const thrown = new Error("Environment API not found for environment environment");

    // Before the fix the launch ran in the first handler of `.then(onFulfilled, onRejected)`:
    // its throw became an unhandled rejection and the draft showed nothing.
    const attempt = await startNewTaskFromSource({
      attempt: baseAttempt,
      createWorktree: async () => ({ sessionId: nodeThreadId }),
      launch: () => {
        throw thrown;
      },
      onFailure,
    });

    expect(attempt).toBeNull();
    expect(onFailure).toHaveBeenCalledWith(thrown);
  });
});
