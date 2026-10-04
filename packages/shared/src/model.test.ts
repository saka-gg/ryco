import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
} from "@ryco/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelDisplayLabel,
  getModelDisplayName,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  isClaudeUltrathinkPrompt,
  modelSelectionRequiresContextHandoff,
  normalizeModelSlug,
  resolveModelSlugForProvider,
  resolveSelectableModel,
  sameModelSelection,
  trimOrNull,
} from "./model.ts";

describe("model presentation", () => {
  it("uses the picker-compatible short name and sub-provider label", () => {
    const model = {
      slug: "claude-fable-5",
      name: "Claude Fable 5",
      shortName: "Fable 5",
      subProvider: "Anthropic",
    };

    expect(getModelDisplayName(model)).toBe("Claude Fable 5");
    expect(getModelDisplayName(model, { preferShortName: true })).toBe("Fable 5");
    expect(getModelDisplayLabel(model, { preferShortName: true })).toBe("Anthropic · Fable 5");
  });

  it("trims catalog labels and falls back through name to slug", () => {
    expect(
      getModelDisplayLabel(
        { slug: "vendor/model", name: " Friendly Model ", shortName: "  ", subProvider: "  " },
        { preferShortName: true },
      ),
    ).toBe("Friendly Model");
    expect(
      getModelDisplayLabel(
        { slug: "vendor/model", name: " ", shortName: " ", subProvider: "Vendor" },
        { preferShortName: true },
      ),
    ).toBe("Vendor · vendor/model");
  });
});

describe("sameModelSelection", () => {
  const instanceId = ProviderInstanceId.make("claude_work");

  it("ignores key order and option order", () => {
    expect(
      sameModelSelection(
        {
          instanceId,
          model: "claude-opus-5",
          options: [
            { id: "effort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
        JSON.parse(
          '{"options":[{"value":true,"id":"fastMode"},{"value":"high","id":"effort"}],"model":"claude-opus-5","instanceId":"claude_work"}',
        ),
      ),
    ).toBe(true);
  });

  it("treats absent options as an empty list", () => {
    expect(
      sameModelSelection(
        { instanceId, model: "claude-opus-5" },
        {
          instanceId,
          model: "claude-opus-5",
          options: [],
        },
      ),
    ).toBe(true);
  });

  it("detects a different model, instance or option value", () => {
    const base = { instanceId, model: "claude-opus-5", options: [{ id: "effort", value: "high" }] };
    expect(sameModelSelection(base, { ...base, model: "claude-fable-5" })).toBe(false);
    expect(
      sameModelSelection(base, { ...base, instanceId: ProviderInstanceId.make("claude_personal") }),
    ).toBe(false);
    expect(sameModelSelection(base, { ...base, options: [{ id: "effort", value: "low" }] })).toBe(
      false,
    );
    expect(sameModelSelection(base, { ...base, options: [] })).toBe(false);
  });
});

describe("context handoff boundary", () => {
  const canonicalSelection = createModelSelection(
    ProviderInstanceId.make("claude_work"),
    "claude-fable-5",
  );

  it("requires a handoff only when the configured provider instance changes", () => {
    expect(
      modelSelectionRequiresContextHandoff({
        canonicalSelection,
        targetSelection: createModelSelection(
          ProviderInstanceId.make("claude_work"),
          "claude-opus-5",
        ),
      }),
    ).toBe(false);
    expect(
      modelSelectionRequiresContextHandoff({
        canonicalSelection,
        targetSelection: createModelSelection(
          ProviderInstanceId.make("claude_personal"),
          "claude-opus-5",
        ),
      }),
    ).toBe(true);
  });
});

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    expect(normalizeModelSlug("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("5.6")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("sol")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("terra")).toBe("gpt-5.6-terra");
    expect(normalizeModelSlug("luna")).toBe("gpt-5.6-luna");
    expect(normalizeModelSlug("gpt-5-codex")).toBe("gpt-5.4");
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-4-8");
    expect(normalizeModelSlug("opus-4.8", claude)).toBe("claude-opus-4-8");
    expect(normalizeModelSlug("sonnet", claude)).toBe("claude-sonnet-5");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveModelSlugForProvider", () => {
  it("returns defaults when the model is missing", () => {
    expect(resolveModelSlugForProvider(ProviderDriverKind.make("codex"), undefined)).toBe(
      DEFAULT_MODEL,
    );
    expect(resolveModelSlugForProvider(ProviderDriverKind.make("ollama"), undefined)).toBe(
      DEFAULT_MODEL,
    );
  });

  it("preserves normalized unknown models", () => {
    expect(
      resolveModelSlugForProvider(ProviderDriverKind.make("codex"), "custom/internal-model"),
    ).toBe("custom/internal-model");
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slugs, labels, and aliases", () => {
    const options = [
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
    ];
    expect(resolveSelectableModel(ProviderDriverKind.make("codex"), "gpt-5.3-codex", options)).toBe(
      "gpt-5.3-codex",
    );
    expect(resolveSelectableModel(ProviderDriverKind.make("codex"), "gpt-5.3 codex", options)).toBe(
      "gpt-5.3-codex",
    );
    expect(resolveSelectableModel(ProviderDriverKind.make("claudeAgent"), "sonnet", options)).toBe(
      "claude-sonnet-5",
    );
  });
});

describe("misc helpers", () => {
  it("detects ultrathink prompts", () => {
    expect(isClaudeUltrathinkPrompt("Please ultrathink about this")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Investigate")).toBe(false);
  });

  it("prefixes ultrathink prompts once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
  });

  it("trims strings to null", () => {
    expect(trimOrNull("  hi  ")).toBe("hi");
    expect(trimOrNull("   ")).toBeNull();
  });
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});
