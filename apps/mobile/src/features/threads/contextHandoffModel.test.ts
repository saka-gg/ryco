import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  contextHandoffMarkerAccessibilityLabel,
  derivePendingContextHandoff,
} from "./contextHandoffModel";

const config = {
  providers: [
    {
      instanceId: "codex-work",
      driver: "codex",
      displayName: "OpenAI Work",
      accentColor: "#111111",
      models: [{ slug: "gpt-5.6", name: "GPT-5.6", shortName: "GPT-5.6" }],
    },
    {
      instanceId: "claude-work",
      driver: "claudeAgent",
      displayName: "Claude Work",
      models: [{ slug: "claude-opus-5", name: "Claude Opus 5", shortName: "Opus 5" }],
    },
  ],
} as unknown as ServerConfig;

const codex = { instanceId: "codex-work", model: "gpt-5.6" } as ModelSelection;
const claude = { instanceId: "claude-work", model: "claude-opus-5" } as ModelSelection;

describe("mobile context handoff presentation", () => {
  it("previews the provider boundary staged for the next message", () => {
    const pending = derivePendingContextHandoff({
      threadStarted: true,
      canonicalSelection: codex,
      targetSelection: claude,
      serverConfig: config,
    });

    expect(pending?.source.driverKind).toBe("codex");
    expect(pending?.target.driverKind).toBe("claudeAgent");
    expect(pending?.target.modelDisplayName).toBe("Opus 5");
    expect(pending?.accessibilityLabel).toContain("OpenAI Work GPT-5.6");
    expect(pending?.accessibilityLabel).toContain("Claude Work Opus 5");
  });

  it("does not call a same-provider model change a context handoff", () => {
    expect(
      derivePendingContextHandoff({
        threadStarted: true,
        canonicalSelection: codex,
        targetSelection: { ...codex, model: "gpt-5.5" },
        serverConfig: config,
      }),
    ).toBeNull();
  });

  it("announces delivery uncertainty using the existing handoff vocabulary", () => {
    expect(
      contextHandoffMarkerAccessibilityLabel({
        sources: [
          {
            providerInstanceId: ProviderInstanceId.make("codex-work"),
            driverKind: ProviderDriverKind.make("codex"),
            modelSlug: "gpt-5.6",
          },
        ],
        target: {
          providerInstanceId: ProviderInstanceId.make("claude-work"),
          driverKind: ProviderDriverKind.make("claudeAgent"),
          modelSlug: "claude-opus-5",
        },
        status: "delivery-uncertain",
        error: "Connection closed",
      }),
    ).toBe(
      "Context handoff from Codex gpt-5.6 to Claude claude-opus-5. Delivery uncertain: Connection closed",
    );
  });

  it("reads a working-folder relocation as a fresh session, not a model transition", () => {
    // A chat turned into a project keeps its model; only its folder moved.
    const endpoint = {
      providerInstanceId: ProviderInstanceId.make("claude-work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      modelSlug: "claude-opus-5",
    };
    const relocation = {
      sources: [endpoint],
      target: endpoint,
      reason: "cwd-relocation" as const,
    };

    expect(contextHandoffMarkerAccessibilityLabel({ ...relocation, status: "consumed" })).toBe(
      "Continued in a fresh session in the new folder",
    );
    expect(
      contextHandoffMarkerAccessibilityLabel({
        ...relocation,
        status: "failed",
        error: "Provider exited",
      }),
    ).toBe(
      "Fresh session in the new folder. Failed: Provider exited. Send your message again to retry",
    );
  });
});
