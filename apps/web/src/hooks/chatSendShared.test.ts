import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentApi,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useUiStateStore } from "../uiStateStore";
import {
  applyBuildModeToSend,
  attachDevicePromptScreenshot,
  persistThreadSettingsForNextTurn,
  resolveEnforceBuildMode,
} from "./chatSendShared";
import type { SendTurnComposerSnapshot, SendTurnSettings } from "./executeChatSendTurn";

function composer(provider: string, overrides: Partial<SendTurnComposerSnapshot> = {}) {
  return {
    prompt: "Do the thing",
    trimmedPrompt: "Do the thing",
    images: [],
    sendableTerminalContexts: [],
    sourceControlContexts: [],
    selectedProvider: ProviderDriverKind.make(provider),
    selectedModel: "model",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: {
      instanceId: ProviderInstanceId.make(provider),
      model: "model",
      options: [{ id: "agent", value: "plan" }],
    },
    expiredTerminalContextCount: 0,
    ...overrides,
  } satisfies SendTurnComposerSnapshot;
}

const planSettings: SendTurnSettings = {
  runtimeMode: "full-access",
  interactionMode: "plan",
  tokenMode: "balanced",
};

describe("persistThreadSettingsForNextTurn", () => {
  it("dispatches only the modes that changed", async () => {
    const dispatchCommand = vi.fn(async (_command: { type: string }) => ({ sequence: 1 }));
    const api = { orchestration: { dispatchCommand } } as unknown as EnvironmentApi;
    const input = {
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-10-01T00:00:00.000Z",
      runtimeMode: "full-access" as const,
      interactionMode: "plan" as const,
      tokenMode: "balanced" as const,
    };
    await persistThreadSettingsForNextTurn(
      api,
      { runtimeMode: "full-access", interactionMode: "plan", tokenMode: "balanced" },
      input,
    );
    expect(dispatchCommand).not.toHaveBeenCalled();
    await persistThreadSettingsForNextTurn(
      api,
      { runtimeMode: "approval-required", interactionMode: "default", tokenMode: "balanced" },
      input,
    );
    expect(dispatchCommand.mock.calls.map(([command]) => command.type)).toEqual([
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
    ]);
  });
});

describe("applyBuildModeToSend", () => {
  it("leaves the snapshot untouched without the Build-mode lock", () => {
    const original = composer("opencode");
    const result = applyBuildModeToSend({
      composer: original,
      settings: planSettings,
      enforceBuildMode: false,
    });
    expect(result.composer).toBe(original);
    expect(result.settings).toBe(planSettings);
  });

  it("forces Build mode and the OpenCode build agent under the lock", () => {
    const result = applyBuildModeToSend({
      composer: composer("opencode"),
      settings: planSettings,
      enforceBuildMode: true,
    });
    expect(result.settings).toEqual({ ...planSettings, interactionMode: "default" });
    expect(result.composer.selectedModelSelection.options).toEqual([
      { id: "agent", value: "build" },
    ]);
    // Other providers keep their selection; only the interaction mode changes.
    const codex = composer("codex");
    expect(
      applyBuildModeToSend({ composer: codex, settings: planSettings, enforceBuildMode: true })
        .composer.selectedModelSelection,
    ).toBe(codex.selectedModelSelection);
  });

  it("reads the lock from UI state", () => {
    useUiStateStore.setState({ alwaysUseBuildMode: true });
    expect(resolveEnforceBuildMode()).toBe(true);
    useUiStateStore.setState({ alwaysUseBuildMode: false });
    expect(resolveEnforceBuildMode()).toBe(false);
  });
});

describe("attachDevicePromptScreenshot", () => {
  it("returns the composer unchanged and does not notify for an ordinary prompt", async () => {
    const notify = vi.fn();
    const original = composer("codex");
    expect(
      await attachDevicePromptScreenshot({
        api: {} as EnvironmentApi,
        threadId: ThreadId.make("thread-1"),
        composer: original,
        notify,
      }),
    ).toBe(original);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports an unavailable simulator only through the optional notify", async () => {
    const notify = vi.fn();
    const prompt = "Look at the simulator screen";
    await attachDevicePromptScreenshot({
      api: {} as EnvironmentApi,
      threadId: ThreadId.make("thread-1"),
      composer: composer("codex", { prompt, trimmedPrompt: prompt }),
      notify,
    });
    expect(notify).toHaveBeenCalledWith({ kind: "unavailable", reason: "no-attached-device" });
    await expect(
      attachDevicePromptScreenshot({
        api: {} as EnvironmentApi,
        threadId: ThreadId.make("thread-1"),
        composer: composer("codex", { prompt, trimmedPrompt: prompt }),
      }),
    ).resolves.toBeDefined();
  });
});
