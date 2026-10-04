import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkpointRevertUnsupportedMessage } from "./providerModels.ts";

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
