import { describe, expect, it, vi } from "vite-plus/test";

import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";

import {
  createNewTaskAttempt,
  runNewTaskAttempt,
  type NewTaskControllerDeps,
  type NewTaskStableIds,
} from "./newTaskController";

const ids: NewTaskStableIds = {
  projectId: ProjectId.make("project-new"),
  projectCommandId: CommandId.make("command-project"),
  threadId: ThreadId.make("thread-new"),
  threadCommandId: CommandId.make("command-thread"),
  attachCommandId: CommandId.make("command-attach"),
  turnCommandId: CommandId.make("command-turn"),
  messageId: MessageId.make("message-new"),
};
const environmentId = EnvironmentId.make("environment");
const existingProjectId = ProjectId.make("project-existing");
const createdAt = "2026-07-26T09:00:00.000Z";

function deps(
  overrides: Partial<NewTaskControllerDeps> = {},
): NewTaskControllerDeps & { readonly commands: ClientOrchestrationCommand[] } {
  const commands: ClientOrchestrationCommand[] = [];
  return {
    commands,
    dispatch: async (command) => {
      commands.push(command);
    },
    createWorktree: async () => ({
      worktreeId: WorktreeId.make("worktree-created"),
      threadId: ThreadId.make("thread-from-worktree"),
    }),
    waitForProject: async () => undefined,
    waitForWorktree: async () => undefined,
    waitForThread: async () => undefined,
    ...overrides,
  };
}

describe("New Task controller", () => {
  it.each(["default", "plan", "ask"] as const)(
    "starts a thread in %s mode with the selected model options",
    async (interactionMode) => {
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoning", value: "high" },
          { id: "fast", value: true },
        ],
      };
      const attempt = createNewTaskAttempt({
        environmentId,
        prompt: "Fix the mobile header",
        modelSelection,
        interactionMode,
        project: {
          kind: "existing",
          projectId: existingProjectId,
          workspaceRoot: "/code/ryco",
        },
        worktree: { kind: "local" },
        createdAt,
        ids,
      });
      const runtime = deps();
      const result = await runNewTaskAttempt(attempt, runtime);

      expect(result.ok).toBe(true);
      expect(runtime.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      expect(runtime.commands[0]).toMatchObject({
        commandId: ids.threadCommandId,
        threadId: ids.threadId,
        modelSelection,
        interactionMode,
        tokenMode: "off",
      });
      expect(runtime.commands[1]).toMatchObject({
        commandId: ids.turnCommandId,
        message: { messageId: ids.messageId, text: "Fix the mobile header" },
        modelSelection,
        interactionMode,
        tokenMode: "off",
      });
    },
  );

  it("preserves an explicit token-saving opt-in on creation and turn start", async () => {
    const runtime = deps();
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Use the selected token mode",
        project: {
          kind: "existing",
          projectId: existingProjectId,
          workspaceRoot: "/code/ryco",
        },
        worktree: { kind: "local" },
        tokenMode: "balanced",
        createdAt,
        ids,
      }),
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(runtime.commands).toHaveLength(2);
    expect(runtime.commands[0]).toMatchObject({ type: "thread.create", tokenMode: "balanced" });
    expect(runtime.commands[1]).toMatchObject({
      type: "thread.turn.start",
      tokenMode: "balanced",
    });
  });

  it("waits for a new project before creating its thread", async () => {
    const order: string[] = [];
    const runtime = deps({
      dispatch: async (command) => {
        order.push(`dispatch:${command.type}`);
      },
      waitForProject: async () => {
        order.push("wait:project");
      },
      waitForThread: async () => {
        order.push("wait:thread");
      },
    });
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Start here",
        project: { kind: "new", workspaceRoot: "/code/new-project" },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      runtime,
    );

    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "dispatch:project.create",
      "wait:project",
      "dispatch:thread.create",
      "wait:thread",
      "dispatch:thread.turn.start",
    ]);
  });

  it.each([undefined, " release/v2 "])(
    "uses the server-managed worktree with source %s and does not create a second thread",
    async (baseBranch) => {
      const createWorktree = vi.fn(async () => ({
        worktreeId: WorktreeId.make("worktree-created"),
        threadId: ThreadId.make("thread-from-worktree"),
      }));
      const runtime = deps({ createWorktree });
      const result = await runNewTaskAttempt(
        createNewTaskAttempt({
          environmentId,
          prompt: "Isolate this change",
          project: {
            kind: "existing",
            projectId: existingProjectId,
            workspaceRoot: "/code/ryco",
          },
          worktree: { kind: "new", branch: "feat/mobile", ...(baseBranch ? { baseBranch } : {}) },
          createdAt,
          ids,
        }),
        runtime,
      );

      expect(result.ok).toBe(true);
      expect(createWorktree).toHaveBeenCalledWith({
        projectId: existingProjectId,
        branch: "feat/mobile",
        ...(baseBranch ? { baseBranch: "release/v2" } : {}),
      });
      expect(runtime.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
      expect(result.attempt.threadId).toBe("thread-from-worktree");
    },
  );

  it("retains successful hierarchy steps and retries only the failed thread step", async () => {
    let failThread = true;
    const commands: ClientOrchestrationCommand[] = [];
    const runtime = deps({
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "thread.create" && failThread) {
          failThread = false;
          throw new Error("offline");
        }
      },
    });
    const first = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Keep my draft",
        project: { kind: "new", workspaceRoot: "/code/new-project" },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      runtime,
    );
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected failure");
    expect(first.step).toBe("thread");
    expect(first.attempt.projectReady).toBe(true);
    expect(first.attempt.prompt).toBe("Keep my draft");

    const second = await runNewTaskAttempt(first.attempt, runtime);
    expect(second.ok).toBe(true);
    expect(commands.filter((command) => command.type === "project.create")).toHaveLength(1);
    expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(2);
  });

  it("reports uncertain turn delivery without dropping the authoritative thread", async () => {
    const runtime = deps({
      dispatch: async (command) => {
        if (command.type === "thread.turn.start") throw new Error("socket closed");
      },
    });
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Do not lose this",
        project: {
          kind: "existing",
          projectId: existingProjectId,
          workspaceRoot: "/code/ryco",
        },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      runtime,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.step).toBe("turn");
    expect(result.deliveryUncertain).toBe(true);
    expect(result.attempt.threadReady).toBe(true);
    expect(result.attempt.prompt).toBe("Do not lose this");
  });
});
