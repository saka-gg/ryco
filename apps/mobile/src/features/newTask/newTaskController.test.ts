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
import { TaskChatStartError } from "../tasks/taskChatStartError";

const ids: NewTaskStableIds = {
  projectId: ProjectId.make("project-new"),
  projectCommandId: CommandId.make("command-project"),
  threadId: ThreadId.make("thread-new"),
  threadCommandId: CommandId.make("command-thread"),
  attachCommandId: CommandId.make("command-attach"),
  turnCommandId: CommandId.make("command-turn"),
  messageId: MessageId.make("message-new"),
};
/** The node's typed refusal, as the RPC client decodes it: a definite answer. */
function nodeRefusal(message: string): Error {
  return Object.assign(new Error(message), { _tag: "OrchestrationDispatchCommandError" });
}

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
          throw nodeRefusal("A branch named 'feat/mobile' already exists.");
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

  it("never sends a worktree-preparing turn start again once its thread has started", async () => {
    const runtime = deps({ threadStarted: (threadId) => threadId === ids.threadId });
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Isolate this change",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: { kind: "new", branch: "feat/mobile", baseBranch: "HEAD", fetchOrigin: false },
        createdAt,
        ids,
      }),
      runtime,
    );
    expect(result.ok).toBe(true);
    expect(result.attempt.turnStarted).toBe(true);
    expect(runtime.commands).toEqual([]);
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
        if (command.type === "thread.create") throw nodeRefusal("This project is archived.");
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

  it.each([
    "All fibers interrupted without error",
    "The Hub could not confirm the command reached the machine.",
    "SocketCloseError: closed",
  ])("calls a drop that is not the node's answer uncertain: %s", async (message) => {
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Start here",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      deps({
        dispatch: async () => {
          throw new Error(message);
        },
      }),
    );
    if (result.ok) throw new Error("expected failure");
    expect(result).toMatchObject({ step: "thread", deliveryUncertain: true });
    expect(result.message).not.toContain(message);
  });

  it("refuses a bad workspace path before sending anything, as certain", async () => {
    const runtime = deps();
    const result = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Start here",
        project: { kind: "new", workspaceRoot: "relative/path" },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      runtime,
    );
    if (result.ok) throw new Error("expected failure");
    expect(result).toMatchObject({ step: "project", deliveryUncertain: false });
    expect(runtime.commands).toEqual([]);
  });

  it("renews a refused turn start's and a refused attach's command id for a retry", async () => {
    const turnRefused = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Start here",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: { kind: "local" },
        createdAt,
        ids,
      }),
      deps({
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") throw nodeRefusal("Model unavailable.");
        },
      }),
    );
    if (turnRefused.ok) throw new Error("expected failure");
    expect(turnRefused).toMatchObject({ step: "turn", deliveryUncertain: false });
    const fresh = () => CommandId.make("command-fresh");
    expect(prepareNewTaskRetry(turnRefused.attempt, turnRefused, fresh).ids).toEqual({
      ...ids,
      turnCommandId: "command-fresh",
    });

    const attachRefused = await runNewTaskAttempt(
      createNewTaskAttempt({
        environmentId,
        prompt: "Start here",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: {
          kind: "existing",
          worktreeId: "worktree-1" as never,
          branch: "feat/x",
          worktreePath: "/code/ryco-x",
        },
        createdAt,
        ids,
      }),
      deps({
        dispatch: async (command) => {
          if (command.type === "thread.attach-to-worktree") throw nodeRefusal("Worktree gone.");
        },
      }),
    );
    if (attachRefused.ok) throw new Error("expected failure");
    expect(attachRefused).toMatchObject({ step: "thread", deliveryUncertain: false });
    expect(prepareNewTaskRetry(attachRefused.attempt, attachRefused, fresh).ids).toEqual({
      ...ids,
      attachCommandId: "command-fresh",
    });
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

  it("writes the chosen modes to a thread the node created before its first turn", async () => {
    // A task started from a pull request: `git.createWorktreeForProject` made the thread in
    // full access and default mode, and the node runs a turn in the thread's modes.
    const attempt = {
      ...createNewTaskAttempt({
        environmentId,
        prompt: "Review the PR",
        project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
        worktree: { kind: "local" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        tokenMode: "balanced",
        createdAt,
        ids,
      }),
      threadCommandAccepted: true,
      threadReady: true,
      worktreeAttached: true,
      threadSettingsPending: true,
    };
    const failing = deps({
      dispatch: async (command) => {
        if (command.type === "thread.interaction-mode.set") throw nodeRefusal("Thread is gone.");
      },
    });
    const refused = await runNewTaskAttempt(attempt, failing);
    if (refused.ok) throw new Error("expected failure");
    // Never a turn in the node's modes.
    expect(refused.step).toBe("turn");
    expect(refused.attempt.turnStarted).toBe(false);
    expect(refused.attempt.threadSettingsPending).toBe(true);

    const runtime = deps();
    const result = await runNewTaskAttempt(attempt, runtime);
    expect(result.ok).toBe(true);
    expect(runtime.commands).toEqual([
      expect.objectContaining({
        type: "thread.runtime-mode.set",
        commandId: "command-turn:runtime-mode",
        threadId: ids.threadId,
        runtimeMode: "approval-required",
      }),
      expect.objectContaining({
        type: "thread.interaction-mode.set",
        commandId: "command-turn:interaction-mode",
        interactionMode: "plan",
      }),
      expect.objectContaining({
        type: "thread.token-mode.set",
        commandId: "command-turn:token-mode",
        tokenMode: "balanced",
      }),
      expect.objectContaining({ type: "thread.turn.start", interactionMode: "plan" }),
    ]);
    if (!result.ok) throw new Error("expected success");
    expect(result.attempt.threadSettingsPending).toBe(false);
  });
});

describe("New Task controller for a task's chat", () => {
  const taskAttempt = (worktree: "local" | "new") =>
    createNewTaskAttempt({
      environmentId,
      prompt: "Ship the follow-up\n\nLinked:\n- Branch feature/x",
      project: { kind: "existing", projectId: existingProjectId, workspaceRoot: "/code/ryco" },
      worktree:
        worktree === "local"
          ? { kind: "local" }
          : {
              kind: "new",
              branch: "task/ship-follow-up",
              baseBranch: "feature/x",
              fetchOrigin: false,
            },
      createdAt,
      ids,
      localTaskId: "task-1",
    });

  it("sends the first turn as the task's and everything else as before", async () => {
    const delegated: Array<{ taskId: string; type: string }> = [];
    const runtime = deps({
      delegate: async (taskId, command) => {
        delegated.push({ taskId, type: command.type });
      },
    });
    const result = await runNewTaskAttempt(taskAttempt("local"), runtime);

    expect(result.ok).toBe(true);
    expect(runtime.commands.map((command) => command.type)).toEqual(["thread.create"]);
    expect(delegated).toEqual([{ taskId: "task-1", type: "thread.turn.start" }]);
  });

  it("creates the worktree inside the task's turn start", async () => {
    const delegate = vi.fn(async () => undefined);
    const runtime = deps({ delegate });
    const result = await runNewTaskAttempt(taskAttempt("new"), runtime);

    expect(result.ok).toBe(true);
    expect(runtime.commands).toEqual([]);
    expect(delegate).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        type: "thread.turn.start",
        bootstrap: expect.objectContaining({
          prepareWorktree: expect.objectContaining({
            branch: "task/ship-follow-up",
            baseBranch: "feature/x",
          }),
        }),
      }),
    );
  });

  it("shows why a start was refused here, and retries one the machine recorded under its id", async () => {
    const refusedHere = await runNewTaskAttempt(
      taskAttempt("new"),
      deps({
        delegate: async () => {
          throw new TaskChatStartError("The task is done.", false);
        },
      }),
    );
    expect(refusedHere).toMatchObject({
      ok: false,
      step: "worktree",
      message: "The task is done.",
      deliveryUncertain: false,
    });

    const recordedFailed = await runNewTaskAttempt(
      taskAttempt("new"),
      deps({
        delegate: async () => {
          throw new TaskChatStartError("Provider unavailable.", true);
        },
      }),
    );
    expect(recordedFailed).toMatchObject({
      ok: false,
      message: "Provider unavailable.",
      deliveryUncertain: true,
    });
    if (recordedFailed.ok) throw new Error("expected a failure");
    const retry = prepareNewTaskRetry(recordedFailed.attempt, recordedFailed, () =>
      CommandId.make("command-fresh"),
    );
    expect(retry.ids.turnCommandId).toBe(ids.turnCommandId);
    expect(retry.localTaskId).toBe("task-1");
  });

  it("checks the task before creating anything for its chat", async () => {
    const runtime = deps({
      delegate: async () => undefined,
      preflightTask: async () => {
        throw new TaskChatStartError("The task was deleted.", false);
      },
    });
    const result = await runNewTaskAttempt(taskAttempt("local"), runtime);
    expect(result).toMatchObject({
      ok: false,
      message: "The task was deleted.",
      deliveryUncertain: false,
    });
    expect(runtime.commands).toEqual([]);
  });

  it("refuses a task's chat where it cannot be sent as the task's", async () => {
    const result = await runNewTaskAttempt(taskAttempt("local"), deps());
    expect(result).toMatchObject({ ok: false, step: "turn", deliveryUncertain: false });
  });

  it("starts a chat without a project in one turn start that creates its folder and thread", async () => {
    const attempt = createNewTaskAttempt({
      environmentId,
      prompt: "  Plan a trip to   Lisbon ",
      project: { kind: "chat" },
      worktree: { kind: "local" },
      createdAt,
      ids,
    });
    const runtime = deps();
    const result = await runNewTaskAttempt(attempt, runtime);

    expect(result.ok).toBe(true);
    expect(runtime.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
    const turn = runtime.commands[0] as Extract<
      ClientOrchestrationCommand,
      { type: "thread.turn.start" }
    >;
    expect(turn.commandId).toBe(ids.turnCommandId);
    expect(turn.bootstrap?.createChatProject).toEqual({
      projectId: ids.projectId,
      titleSeed: "Plan a trip to Lisbon",
    });
    expect(turn.bootstrap?.createThread).toMatchObject({
      projectId: ids.projectId,
      branch: null,
      worktreePath: null,
    });
    expect(turn.bootstrap?.prepareWorktree).toBeUndefined();
    if (result.ok) {
      expect(result.attempt).toMatchObject({
        projectReady: true,
        threadReady: true,
        turnStarted: true,
      });
    }
  });

  it("starts a retired chat draft again under fresh ids, once", async () => {
    const retired = Object.assign(new Error("retired"), {
      _tag: "OrchestrationDispatchCommandError",
      reason: "chat-project-retired",
    });
    const freshProjectId = ProjectId.make("project-fresh");
    const freshCommandId = CommandId.make("command-turn-fresh");
    const sent: ClientOrchestrationCommand[] = [];
    const runtime = deps({
      dispatch: async (command) => {
        sent.push(command);
        if (sent.length === 1) throw retired;
      },
      freshChatIds: () => ({ projectId: freshProjectId, turnCommandId: freshCommandId }),
    });
    const attempt = createNewTaskAttempt({
      environmentId,
      prompt: "Plan a trip",
      project: { kind: "chat" },
      worktree: { kind: "local" },
      createdAt,
      ids,
    });
    const result = await runNewTaskAttempt(attempt, runtime);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      commandId: freshCommandId,
      bootstrap: {
        createChatProject: { projectId: freshProjectId },
        createThread: { projectId: freshProjectId },
      },
    });

    const again = deps({
      dispatch: async () => {
        throw retired;
      },
      freshChatIds: () => ({ projectId: freshProjectId, turnCommandId: freshCommandId }),
    });
    const failed = await runNewTaskAttempt(attempt, again);
    expect(failed).toMatchObject({ ok: false, step: "turn", deliveryUncertain: false });
  });

  it("does not send a chat's turn again once the node shows it started", async () => {
    const runtime = deps({ threadStarted: () => true });
    const attempt = createNewTaskAttempt({
      environmentId,
      prompt: "Plan a trip",
      project: { kind: "chat" },
      worktree: { kind: "local" },
      createdAt,
      ids,
    });
    const result = await runNewTaskAttempt(attempt, runtime);
    expect(result.ok).toBe(true);
    expect(runtime.commands).toEqual([]);
  });
});
