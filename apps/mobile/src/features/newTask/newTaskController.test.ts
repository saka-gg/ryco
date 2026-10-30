import { describe, expect, it, vi } from "vite-plus/test";

import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";

import {
  createNewTaskAttempt,
  prepareNewTaskRetry,
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
    waitForProject: async () => undefined,
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

  it("prepares a new worktree inside the turn start, under this attempt's own thread id", async () => {
    const waitForThread = vi.fn(async () => undefined);
    const runtime = deps({ waitForThread });
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Isolate this change",
        project: {
          kind: "existing",
          projectId: existingProjectId,
          workspaceRoot: "/code/ryco",
        },
        worktree: {
          kind: "new",
          branch: " feat/mobile ",
          baseBranch: "origin/release/v2",
          fetchOrigin: true,
        },
        tokenMode: "balanced",
        createdAt,
        ids,
      }),
      runtime,
    );

    expect(result.ok).toBe(true);
    // One command: no separate worktree RPC, no thread.create, no wait for a thread
    // the node only creates once the checkout exists.
    expect(runtime.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
    expect(waitForThread).not.toHaveBeenCalled();
    expect(runtime.commands[0]).toMatchObject({
      commandId: ids.turnCommandId,
      threadId: ids.threadId,
      message: { messageId: ids.messageId, text: "Isolate this change" },
      tokenMode: "balanced",
      bootstrap: {
        createThread: {
          projectId: existingProjectId,
          title: "Isolate this change",
          branch: null,
          worktreePath: null,
          tokenMode: "balanced",
          createdAt,
        },
        prepareWorktree: {
          projectCwd: "/code/ryco",
          baseBranch: "origin/release/v2",
          branch: "feat/mobile",
          fetchOrigin: true,
        },
      },
    });
    expect(result.attempt.threadId).toBe(ids.threadId);
    expect(result.attempt.turnStarted).toBe(true);
  });

  it("shows the node's refusal of a new worktree as certain and keeps the attempt's ids", async () => {
    let refuse = true;
    const runtime = deps({
      dispatch: async (command) => {
        runtime.commands.push(command);
        if (refuse) {
          refuse = false;
          throw new Error("A branch named 'feat/mobile' already exists.");
        }
      },
    });
    const attempt = createNewTaskAttempt({
      environmentId,
      prompt: "Isolate this change",
      project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
      worktree: {
        kind: "new",
        branch: "feat/mobile",
        baseBranch: "origin/HEAD",
        fetchOrigin: true,
      },
      createdAt,
      ids,
    });
    const first = await runNewTaskAttempt(attempt, runtime);
    if (first.ok) throw new Error("expected failure");
    expect(first.step).toBe("worktree");
    expect(first.message).toBe("A branch named 'feat/mobile' already exists.");
    expect(first.deliveryUncertain).toBe(false);

    const second = await runNewTaskAttempt(first.attempt, runtime);
    expect(second.ok).toBe(true);
    expect(runtime.commands.map((command) => command.commandId)).toEqual([
      ids.turnCommandId,
      ids.turnCommandId,
    ]);
  });

  it("calls a lost new-worktree turn start uncertain, with the step's own text", async () => {
    const runtime = deps({
      dispatch: async () => {
        throw new Error("SocketCloseError: the connection closed");
      },
    });
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Isolate this change",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: {
          kind: "new",
          branch: "feat/mobile",
          baseBranch: "origin/HEAD",
          fetchOrigin: true,
        },
        createdAt,
        ids,
      }),
      runtime,
    );
    if (result.ok) throw new Error("expected failure");
    expect(result.deliveryUncertain).toBe(true);
    expect(result.message).not.toContain("SocketCloseError");
  });

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

  it("shows the node's refusal of a step as certain, and a lost connection as uncertain", async () => {
    const refusing = deps({
      dispatch: async (command) => {
        if (command.type === "thread.create") throw new Error("This project is archived.");
      },
    });
    const refusal = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Start here",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      refusing,
    );
    if (refusal.ok) throw new Error("expected failure");
    expect(refusal).toMatchObject({
      step: "thread",
      message: "This project is archived.",
      deliveryUncertain: false,
    });

    const lost = await runNewTaskAttempt(
      refusal.attempt,
      deps({
        dispatch: async () => {
          throw new Error("SocketReadError: heartbeat missed");
        },
      }),
    );
    if (lost.ok) throw new Error("expected failure");
    expect(lost.deliveryUncertain).toBe(true);
    expect(lost.message).toBe(
      "The task could not be confirmed. The project and worktree remain available.",
    );
  });

  it("renews only a refused step's command id for a retry", () => {
    const base = createNewTaskAttempt({
      environmentId,
      prompt: "Start here",
      project: { kind: "new", workspaceRoot: "/code/new-project" },
      worktree: { kind: "local" },
      createdAt,
      ids,
    });
    const fresh = () => CommandId.make("command-fresh");
    expect(
      prepareNewTaskRetry(base, { step: "project", deliveryUncertain: false }, fresh).ids,
    ).toEqual({ ...ids, projectCommandId: "command-fresh" });
    // May have been delivered: the node answers the same id from its receipt.
    expect(prepareNewTaskRetry(base, { step: "project", deliveryUncertain: true }, fresh)).toBe(
      base,
    );
    const projectDone = { ...base, projectCommandAccepted: true, projectReady: true };
    expect(
      prepareNewTaskRetry(projectDone, { step: "thread", deliveryUncertain: false }, fresh).ids,
    ).toEqual({ ...ids, threadCommandId: "command-fresh" });
    // Only the confirmation was missing: nothing to renew.
    const threadSent = { ...projectDone, threadCommandAccepted: true };
    expect(
      prepareNewTaskRetry(threadSent, { step: "thread", deliveryUncertain: false }, fresh),
    ).toBe(threadSent);
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
