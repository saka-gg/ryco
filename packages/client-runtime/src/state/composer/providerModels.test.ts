import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkpointRevertUnsupportedMessage,
  getAutoRuntimeModeUnavailableReason,
} from "./providerModels.ts";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-04T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("checkpointRevertUnsupportedMessage", () => {
  it("refuses providers that cannot roll back", () => {
    expect(
      checkpointRevertUnsupportedMessage(provider({ supportsConversationRollback: false })),
    ).toBe(
      "Cursor can't remove turns from its conversation, so this thread can't be reverted. Start a new thread to try a different approach.",
    );
    expect(
      checkpointRevertUnsupportedMessage(
        provider({ supportsConversationRollback: false, displayName: "Work Copilot" }),
      ),
    ).toMatch(/^Work Copilot can't remove turns/);
  });

  it("allows providers that roll back or whose support is unknown", () => {
    expect(
      checkpointRevertUnsupportedMessage(provider({ supportsConversationRollback: true })),
    ).toBe(null);
    expect(checkpointRevertUnsupportedMessage(provider({}))).toBe(null);
    expect(checkpointRevertUnsupportedMessage(undefined)).toBe(null);
  });
});

describe("getAutoRuntimeModeUnavailableReason", () => {
  const models: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      aliases: ["opus"],
      isCustom: false,
      capabilities: null,
      supportsAutoMode: false,
    },
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: null,
      supportsAutoMode: true,
    },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", isCustom: false, capabilities: null },
  ];

  it("refuses a model the provider reports cannot run Auto, by slug or alias", () => {
    const reason = "Claude Opus 4.8 can't run in Auto mode on this provider.";
    expect(getAutoRuntimeModeUnavailableReason(models, "claude-opus-4-8")).toBe(reason);
    expect(getAutoRuntimeModeUnavailableReason(models, "Opus")).toBe(reason);
  });

  it("allows models that support Auto or whose support is unknown", () => {
    expect(getAutoRuntimeModeUnavailableReason(models, "claude-opus-5-5")).toBe(null);
    expect(getAutoRuntimeModeUnavailableReason(models, "claude-haiku-4-5")).toBe(null);
    expect(getAutoRuntimeModeUnavailableReason(models, "claude-unknown")).toBe(null);
    expect(getAutoRuntimeModeUnavailableReason(models, null)).toBe(null);
    expect(getAutoRuntimeModeUnavailableReason([], "claude-opus-4-8")).toBe(null);
  });
});
