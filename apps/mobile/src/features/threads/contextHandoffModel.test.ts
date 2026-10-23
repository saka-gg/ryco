import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  contextHandoffMarkerAccessibilityLabel,
  derivePendingComposerHandoff,
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

  it("reads a fork's handoff as the inherited conversation reaching a fresh session", () => {
    const endpoint = {
      providerInstanceId: ProviderInstanceId.make("claude-work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      modelSlug: "claude-opus-5",
      modelDisplayName: "Opus 5",
    };
    const fork = { sources: [endpoint], target: endpoint, reason: "fork" as const };

    expect(contextHandoffMarkerAccessibilityLabel({ ...fork, status: "consumed" })).toBe(
      "Sent the inherited conversation to a fresh Opus 5 session",
    );
    expect(
      contextHandoffMarkerAccessibilityLabel({
        ...fork,
        status: "delivery-uncertain",
        error: "Connection closed",
      }),
    ).toBe(
      "Couldn't confirm the inherited conversation reached a fresh session. Delivery uncertain: Connection closed. Send your message again to retry",
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
    expect(
      contextHandoffMarkerAccessibilityLabel({
        ...relocation,
        reason: "native-history-unavailable",
        status: "consumed",
      }),
    ).toBe("Continued in a fresh session");
  });

  it("names the model a fork's handoff switched from when it also changed provider", () => {
    const codexEndpoint = {
      providerInstanceId: ProviderInstanceId.make("codex-work"),
      driverKind: ProviderDriverKind.make("codex"),
      providerDisplayName: "OpenAI Work",
      modelSlug: "gpt-5.6",
      modelDisplayName: "GPT-5.6",
    };
    const claudeEndpoint = {
      providerInstanceId: ProviderInstanceId.make("claude-work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      providerDisplayName: "Claude Work",
      modelSlug: "claude-opus-5",
      modelDisplayName: "Opus 5",
    };
    expect(
      contextHandoffMarkerAccessibilityLabel({
        sources: [codexEndpoint],
        target: claudeEndpoint,
        changedFrom: codexEndpoint,
        reason: "fork",
        status: "consumed",
      }),
    ).toBe(
      "Sent the inherited conversation to a fresh Claude Work Opus 5 session, switching from OpenAI Work GPT-5.6",
    );
  });
});

describe("pending composer handoff", () => {
  const forked = (providerContext: "native" | "handoff") => ({
    kind: "thread.forked",
    payload: {
      schemaVersion: 1,
      sourceThreadId: "source",
      sourceMessageId: "source-reply",
      sourceTurnId: "source-turn",
      sourceTitle: "Refactor auth",
      inheritedMessageCount: 4,
      providerContext,
      ...(providerContext === "handoff" ? { handoffReason: "provider-unsupported" } : {}),
      checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
      notices: [],
    },
  });
  const consumedHandoff = {
    kind: "context-handoff",
    payload: {
      schemaVersion: 1,
      handoffId: "handoff-1",
      mode: "full-context-fresh-session",
      reason: "fork",
      targetMessageId: "first-own-message",
      sourceSelection: codex,
      targetSelection: codex,
      sources: [{ providerInstanceId: "codex-work", driverKind: "codex", modelSlug: "gpt-5.6" }],
      target: { providerInstanceId: "codex-work", driverKind: "codex", modelSlug: "gpt-5.6" },
      contextVersion: 1,
      contextDigest: "a".repeat(64),
      status: "consumed",
    },
  };
  const derive = (
    activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
    targetSelection: ModelSelection = claude,
  ) =>
    derivePendingComposerHandoff({
      activities,
      threadStarted: true,
      canonicalSelection: codex,
      targetSelection,
      serverConfig: config,
    });

  it("says the next message sends a handoff fork's conversation, even when the model changed", () => {
    expect(derive([forked("handoff")])).toEqual({ kind: "fork" });
    expect(derive([forked("handoff")], codex)).toEqual({ kind: "fork" });
  });

  it("keeps the model-change chip for native forks and once the fork's handoff was consumed", () => {
    expect(derive([forked("native")])).toMatchObject({
      kind: "model-change",
      target: { driverKind: "claudeAgent" },
    });
    expect(derive([forked("handoff"), consumedHandoff])).toMatchObject({ kind: "model-change" });
    expect(derive([forked("handoff"), consumedHandoff], codex)).toBeNull();
    expect(derive([], codex)).toBeNull();
  });
});
