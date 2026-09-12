import {
  CommandId,
  DEFAULT_MODEL,
  MessageId,
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

import {
  buildSendTurnBootstrap,
  commitSendTurnDispatch,
  resolveThreadCreateModelSelection,
} from "./sendEngine.ts";

describe("send engine — bootstrap", () => {
  it.each([null, "feature/custom"])("preserves fetch preference and branch naming (%s)", (name) => {
    const bootstrap = buildSendTurnBootstrap({
      isLocalDraftThread: true,
      baseBranchForWorktree: "origin/main",
      fetchOrigin: true,
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
    expect(bootstrap?.prepareWorktree?.baseBranch).toBe("origin/main");
    if (name) expect(bootstrap?.prepareWorktree?.branch).toBe(name);
    else expect(bootstrap?.prepareWorktree?.branch).toMatch(/^team\/tasks\//);
  });
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

  it("falls back to the project default model when the composer has no model", () => {
    expect(
      resolveThreadCreateModelSelection({
        selectedModelSelection: selection,
        selectedModel: "",
        defaultModel: "project-default",
      }).model,
    ).toBe("project-default");
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
