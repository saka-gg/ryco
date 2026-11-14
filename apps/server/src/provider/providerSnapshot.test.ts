import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";

import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  withInstanceIdentity,
} from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ProviderDriverKind.make("opencode"),
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a v-prefixed version such as OpenCode 2.x output", () => {
    expect(parseGenericCliVersion("opencode v2.0.18\n")).toBe("2.0.18");
  });

  it("keeps parsing unprefixed versions unchanged", () => {
    expect(parseGenericCliVersion("1.18.34\n")).toBe("1.18.34");
    expect(parseGenericCliVersion("opencode 1.14.19\n")).toBe("1.14.19");
    expect(parseGenericCliVersion("2.1.111 (Claude Code)")).toBe("2.1.111");
  });

  it("does not match a version glued to a word", () => {
    expect(parseGenericCliVersion("abc1.2.3")).toBeNull();
  });

  it("keeps the first version when Claude stdout is followed by a v-prefixed stderr line", () => {
    expect(parseGenericCliVersion("2.1.111 (Claude Code)\n\n(node:1) Warning: node v20.1.0")).toBe(
      "2.1.111",
    );
  });
});

describe("withInstanceIdentity", () => {
  const draft = buildServerProvider({
    presentation: { displayName: "Codex" },
    enabled: true,
    checkedAt: "2026-11-14T00:00:00.000Z",
    models: [],
    probe: { installed: true, version: "1.0.0", status: "ready", auth: { status: "unknown" } },
  });
  const identity = {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex_work"),
    continuationGroupKey: "codex:home",
  };

  it("stamps the instance, driver, display name, accent color and continuation group", () => {
    const stamped = withInstanceIdentity({
      ...identity,
      displayName: "Work",
      accentColor: "#ff0000",
    })(draft);
    expect(stamped).toEqual({
      ...draft,
      instanceId: identity.instanceId,
      driver: identity.driver,
      displayName: "Work",
      accentColor: "#ff0000",
      continuation: { groupKey: "codex:home" },
    });
  });

  it("keeps the snapshot's own display name and adds no accent color when none is set", () => {
    for (const unset of [undefined, ""]) {
      const stamped = withInstanceIdentity({
        ...identity,
        displayName: unset,
        accentColor: unset,
      })(draft);
      expect(stamped.displayName).toBe("Codex");
      expect("accentColor" in stamped).toBe(false);
      expect(stamped.continuation).toEqual({ groupKey: "codex:home" });
    }
  });

  it("replaces an identity the snapshot already carries", () => {
    const stale = {
      ...draft,
      continuation: { groupKey: "old" },
    };
    const stamped = withInstanceIdentity({
      ...identity,
      displayName: undefined,
      accentColor: undefined,
    })(stale);
    expect(stamped.continuation).toEqual({ groupKey: "codex:home" });
    expect(stamped.instanceId).toBe(identity.instanceId);
  });
});
