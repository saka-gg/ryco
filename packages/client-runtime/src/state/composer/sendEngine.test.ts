import {
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentTokenMode,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { isChatProjectRetiredError } from "./chatDrafts.ts";
import {
  buildSendTurnBootstrap,
  commitSendTurnDispatch,
  resolveThreadCreateModelSelection,
  retargetChatProjectBootstrap,
  type SendTurnBootstrap,
} from "./sendEngine.ts";

describe("send engine — bootstrap", () => {
  it.each([null, "feature/custom"])(
    "preserves fetch preference, disabled setup and branch naming (%s)",
    (name) => {
      const bootstrap = buildSendTurnBootstrap({
        isLocalDraftThread: true,
        baseBranchForWorktree: "origin/main",
        fetchOrigin: true,
        runSetupScript: false,
        worktreeBranchName: name,
        worktreeBranchPrefix: "team/tasks",
        shouldMaterializeLegacyBranchWorktree: false,
        projectId: ProjectId.make("project-1"),
        projectCwd: "/workspace",
        title: "Title",
        threadCreateModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "balanced",
        activeThreadBranch: null,
        worktreePath: null,
        threadCreatedAt: "2026-07-23T00:00:00.000Z",
      });
      expect(bootstrap?.prepareWorktree?.fetchOrigin).toBe(true);
      expect(bootstrap?.runSetupScript).toBe(false);
      expect(bootstrap?.prepareWorktree?.baseBranch).toBe("origin/main");
      if (name) expect(bootstrap?.prepareWorktree?.branch).toBe(name);
      else expect(bootstrap?.prepareWorktree?.branch).toMatch(/^team\/tasks\//);
    },
  );
  it("does not resolve a bootstrap for an existing thread without a worktree", () => {
    expect(
      buildSendTurnBootstrap({
        isLocalDraftThread: false,
        baseBranchForWorktree: null,
        shouldMaterializeLegacyBranchWorktree: false,
        projectId: ProjectId.make("project-1"),
        projectCwd: "/workspace",
        title: "Title",
        threadCreateModelSelection: {
          instanceId: "codex",
          model: "gpt-5",
        } as ModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "balanced",
        activeThreadBranch: null,
        worktreePath: null,
        threadCreatedAt: "2026-07-23T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});

describe("send engine — model resolution", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5", [
    { id: "reasoningEffort", value: "high" },
  ]);

  it("uses the composer's explicit model and preserves instance + options", () => {
    const resolved = resolveThreadCreateModelSelection({
      selectedModelSelection: selection,
      selectedModel: "gpt-5",
      defaultModel: "project-default",
    });
    expect(resolved.model).toBe("gpt-5");
    expect(resolved.instanceId).toBe(selection.instanceId);
    expect(resolved.options).toEqual(selection.options);
  });

  it("ignores a legacy project default when the composer has no model", () => {
    expect(
      resolveThreadCreateModelSelection({
        selectedModelSelection: selection,
        selectedModel: "",
        defaultModel: "project-default",
      }).model,
    ).toBe(DEFAULT_MODEL);
  });

  it("falls back to the global default when neither composer nor project supply a model", () => {
    expect(
      resolveThreadCreateModelSelection({
        selectedModelSelection: selection,
        selectedModel: "",
        defaultModel: null,
      }).model,
    ).toBe(DEFAULT_MODEL);
  });
});

interface DispatchHarness {
  readonly calls: string[];
  readonly commands: Array<{ type: string; [key: string]: unknown }>;
  readonly persisted: Array<Record<string, unknown>>;
  readonly input: Parameters<typeof commitSendTurnDispatch>[0];
}

function makeDispatchHarness(
  overrides: Partial<Parameters<typeof commitSendTurnDispatch>[0]> = {},
): DispatchHarness {
  const calls: string[] = [];
  const commands: Array<{ type: string; [key: string]: unknown }> = [];
  const persisted: Array<Record<string, unknown>> = [];
  let commandCounter = 0;

  const api = {
    orchestration: {
      dispatchCommand: async (command: { type: string; [key: string]: unknown }) => {
        calls.push(`dispatch:${command.type}`);
        commands.push(command);
        return { sequence: commandCounter };
      },
    },
  } as unknown as EnvironmentApi;

  const input: Parameters<typeof commitSendTurnDispatch>[0] = {
    api,
    threadId: ThreadId.make("thread-1"),
    isFirstMessage: true,
    isServerThread: true,
    title: "Session title",
    messageId: MessageId.make("message-1"),
    outgoingMessageText: "hello",
    turnAttachments: [],
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    runtimeMode: "full-access" as RuntimeMode,
    interactionMode: "default" as ProviderInteractionMode,
    tokenMode: "balanced" as AgentTokenMode,
    bootstrap: undefined,
    sourceControlContexts: [],
    createdAt: "2026-07-23T00:00:00.000Z",
    newCommandId: () => CommandId.make(`cmd-${(commandCounter += 1)}`),
    beginLocalDispatch: () => {
      calls.push("beginLocalDispatch");
    },
    persistThreadSettingsForNextTurn: async (settings) => {
      calls.push("persist");
      persisted.push(settings as unknown as Record<string, unknown>);
    },
    ...overrides,
  };

  return { calls, commands, persisted, input };
}

describe("send engine — dispatch assembly", () => {
  it("runs meta.update -> settings persistence -> beginLocalDispatch -> turn.start in order", async () => {
    const harness = makeDispatchHarness();
    await commitSendTurnDispatch(harness.input);

    expect(harness.calls).toEqual([
      "dispatch:thread.meta.update",
      "persist",
      "beginLocalDispatch",
      "dispatch:thread.turn.start",
    ]);
  });

  it("skips the first-message title update when the message is not the first", async () => {
    const harness = makeDispatchHarness({ isFirstMessage: false });
    await commitSendTurnDispatch(harness.input);

    expect(harness.calls).toEqual(["persist", "beginLocalDispatch", "dispatch:thread.turn.start"]);
  });

  it("skips meta.update and settings persistence for a non-server (local draft) thread", async () => {
    const harness = makeDispatchHarness({ isServerThread: false });
    await commitSendTurnDispatch(harness.input);

    expect(harness.calls).toEqual(["beginLocalDispatch", "dispatch:thread.turn.start"]);
  });

  it("never persists the staged target before turn.start", async () => {
    const target = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-sonnet");
    const harness = makeDispatchHarness({ modelSelection: target });
    await commitSendTurnDispatch(harness.input);

    expect(harness.persisted[0]).toBeDefined();
    expect(harness.persisted[0]).not.toHaveProperty("modelSelection");
    expect(harness.commands).not.toContainEqual(
      expect.objectContaining({
        type: "thread.meta.update",
        modelSelection: expect.anything(),
      }),
    );
    expect(harness.commands).toContainEqual(
      expect.objectContaining({
        type: "thread.turn.start",
        modelSelection: target,
      }),
    );
  });

  it("attaches the bootstrap and source-control contexts to the turn.start command", async () => {
    const harness = makeDispatchHarness({
      goal: { objective: "Finish the migration", status: "active", tokenBudget: 1000 },
      bootstrap: { runSetupScript: true },
      sourceControlContexts: [{ id: "sc-1" } as unknown as ComposerSourceControlContext],
    });
    await commitSendTurnDispatch(harness.input);

    const turnStart = harness.commands.find((command) => command.type === "thread.turn.start");
    expect(turnStart).toBeDefined();
    expect(turnStart?.goal).toEqual({
      objective: "Finish the migration",
      status: "active",
      tokenBudget: 1000,
    });
    expect(turnStart).toHaveProperty("bootstrap");
    expect(turnStart).toHaveProperty("sourceControlContexts");
  });
});

describe("send engine — onBeforeTurnStart", () => {
  it("runs exactly once, after beginLocalDispatch and immediately before turn.start", async () => {
    const harness = makeDispatchHarness({ isFirstMessage: true });
    const input = {
      ...harness.input,
      onBeforeTurnStart: () => {
        harness.calls.push("onBeforeTurnStart");
      },
    };
    await commitSendTurnDispatch(input);
    expect(harness.calls).toEqual([
      "dispatch:thread.meta.update",
      "persist",
      "beginLocalDispatch",
      "onBeforeTurnStart",
      "dispatch:thread.turn.start",
    ]);
  });

  it("is not called when the send fails before the turn command", async () => {
    let called = 0;
    const harness = makeDispatchHarness({
      messageId: MessageId.make("message-readiness"),
      bootstrap: { requireWorktree: true },
      assertMutationReady: () => {
        throw new Error("Reconnect before sending.");
      },
      onBeforeTurnStart: () => {
        called += 1;
      },
    });
    await expect(commitSendTurnDispatch(harness.input)).rejects.toThrow("Reconnect");
    expect(called).toBe(0);
    expect(harness.calls).not.toContain("dispatch:thread.turn.start");
  });
});

describe("send engine — usage-limit resume", () => {
  it("passes a commandId override and the usage-limit guard to turn.start", async () => {
    const harness = makeDispatchHarness({
      isFirstMessage: false,
      commandId: CommandId.make("usage-limit-resume:limit-1"),
      usageLimitResumeGuard: { limitId: "limit-1", origin: "manual" },
    });
    await commitSendTurnDispatch(harness.input);
    const turnStart = harness.commands.find((command) => command.type === "thread.turn.start");
    expect(turnStart).toMatchObject({
      commandId: "usage-limit-resume:limit-1",
      usageLimitResumeGuard: { limitId: "limit-1", origin: "manual" },
    });
  });

  it("keeps the default command id and omits the guard otherwise", async () => {
    const harness = makeDispatchHarness();
    await commitSendTurnDispatch(harness.input);
    const turnStart = harness.commands.find((command) => command.type === "thread.turn.start");
    expect(turnStart?.commandId).toBe("composer-send:thread-1:message-1");
    expect(turnStart).not.toHaveProperty("usageLimitResumeGuard");
  });
});

describe("send engine — retired chat project", () => {
  const RETIRED_ID = ProjectId.make("chat-retired");
  const FRESH_ID = ProjectId.make("chat-fresh");
  const retired = () =>
    new OrchestrationDispatchCommandError({
      message: "This chat was cleaned up before its first message was sent.",
      reason: "chat-project-retired",
    });
  const chatBootstrap = (): SendTurnBootstrap =>
    buildSendTurnBootstrap({
      isLocalDraftThread: true,
      baseBranchForWorktree: null,
      shouldMaterializeLegacyBranchWorktree: false,
      projectId: RETIRED_ID,
      projectCwd: "",
      title: "Plan a trip",
      threadCreateModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "balanced",
      activeThreadBranch: null,
      worktreePath: null,
      threadCreatedAt: "2026-10-08T00:00:00.000Z",
      createChatProject: { projectId: RETIRED_ID, titleSeed: "Plan a trip" },
    });

  /** A chat first send whose turn starts fail with `failures`, in order, then succeed. */
  function chatHarness(failures: unknown[], renew = true) {
    const renewals: ProjectId[] = [];
    const harness = makeDispatchHarness({
      isServerThread: false,
      bootstrap: chatBootstrap(),
      ...(renew
        ? {
            renewChatProjectId: () => {
              renewals.push(FRESH_ID);
              return FRESH_ID;
            },
          }
        : {}),
    });
    const dispatch = harness.input.api.orchestration.dispatchCommand;
    const api = {
      orchestration: {
        dispatchCommand: async (command: Parameters<typeof dispatch>[0]) => {
          await dispatch(command);
          const failure = failures.shift();
          if (failure !== undefined) throw failure;
          return { sequence: 1 };
        },
      },
    } as unknown as EnvironmentApi;
    const turnStarts = () =>
      harness.commands.filter((command) => command.type === "thread.turn.start") as Array<{
        commandId: string;
        threadId: string;
        message: { messageId: string; text: string };
        bootstrap: NonNullable<SendTurnBootstrap>;
      }>;
    return { input: { ...harness.input, api }, renewals, turnStarts };
  }

  it("sends once more under a fresh project id and command id", async () => {
    const { input, renewals, turnStarts } = chatHarness([retired()]);
    await commitSendTurnDispatch(input);

    expect(renewals).toEqual([FRESH_ID]);
    const [first, second] = turnStarts();
    expect(turnStarts()).toHaveLength(2);
    expect(first?.bootstrap.createChatProject?.projectId).toBe(RETIRED_ID);
    expect(second?.bootstrap.createChatProject).toEqual({
      projectId: FRESH_ID,
      titleSeed: "Plan a trip",
    });
    expect(second?.bootstrap.createThread?.projectId).toBe(FRESH_ID);
    // Same thread and message; only the command is new.
    expect(second?.threadId).toBe(first?.threadId);
    expect(second?.message).toEqual(first?.message);
    expect(first?.commandId).toBe("composer-send:thread-1:message-1");
    expect(second?.commandId).not.toBe(first?.commandId);
  });

  it("retries only once and surfaces the second failure", async () => {
    const second = new OrchestrationDispatchCommandError({ message: "Provider unavailable" });
    const { input, renewals, turnStarts } = chatHarness([retired(), second]);
    await expect(commitSendTurnDispatch(input)).rejects.toBe(second);
    expect(renewals).toHaveLength(1);
    expect(turnStarts()).toHaveLength(2);

    const twice = chatHarness([retired(), retired()]);
    await expect(commitSendTurnDispatch(twice.input)).rejects.toMatchObject({
      reason: "chat-project-retired",
    });
    expect(twice.turnStarts()).toHaveLength(2);
  });

  it("leaves every other failure, and callers without a renewal, alone", async () => {
    const other = new OrchestrationDispatchCommandError({ message: "Project already exists" });
    const plain = chatHarness([other]);
    await expect(commitSendTurnDispatch(plain.input)).rejects.toBe(other);
    expect(plain.renewals).toEqual([]);
    expect(plain.turnStarts()).toHaveLength(1);

    const unrenewable = chatHarness([retired()], false);
    await expect(commitSendTurnDispatch(unrenewable.input)).rejects.toMatchObject({
      reason: "chat-project-retired",
    });
    expect(unrenewable.turnStarts()).toHaveLength(1);
  });

  it("recognises the retired reason by tag and reason, never by message", () => {
    expect(isChatProjectRetiredError(retired())).toBe(true);
    // Decoded off the wire without the class (relay transports): still the same answer.
    expect(
      isChatProjectRetiredError({
        _tag: "OrchestrationDispatchCommandError",
        reason: "chat-project-retired",
        message: "x",
      }),
    ).toBe(true);
    expect(
      isChatProjectRetiredError(
        new OrchestrationDispatchCommandError({
          message: "Project 'chat-retired' already exists and cannot be created twice.",
        }),
      ),
    ).toBe(false);
    expect(isChatProjectRetiredError({ reason: "chat-project-retired" })).toBe(false);
    expect(isChatProjectRetiredError(new Error("chat-project-retired"))).toBe(false);
    expect(isChatProjectRetiredError(null)).toBe(false);
  });

  it("moves a chat bootstrap's project and thread together, and nothing else", () => {
    const moved = retargetChatProjectBootstrap(chatBootstrap(), FRESH_ID);
    expect(moved?.createChatProject?.projectId).toBe(FRESH_ID);
    expect(moved?.createThread?.projectId).toBe(FRESH_ID);
    const plain: SendTurnBootstrap = { runSetupScript: true };
    expect(retargetChatProjectBootstrap(plain, FRESH_ID)).toBe(plain);
    expect(retargetChatProjectBootstrap(undefined, FRESH_ID)).toBeUndefined();
  });
});
