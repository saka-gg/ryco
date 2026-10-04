import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ModelCapabilities } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";

import { parseGenericCliVersion, providerModelsFromSettings } from "./providerSnapshot.ts";

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
