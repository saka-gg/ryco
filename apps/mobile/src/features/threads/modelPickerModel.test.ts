import type { ModelSelection, ServerConfig, ModelCapabilities } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelPickerModel,
  buildModelPickerModelFromOptions,
  buildModelOptionControls,
  applyModelOption,
  listModelPickerEntries,
  resolveModelPickerSelection,
  resolveModelPillFastMode,
  shortChoiceLabel,
} from "./modelPickerModel";
import { buildModelOptions } from "../../lib/modelOptions";

function provider(instanceId: string, driver: string, models: ReadonlyArray<string>) {
  return {
    instanceId,
    driver,
    displayName: undefined,
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: models.map((slug) => ({ slug, name: slug.toUpperCase(), capabilities: null })),
  };
}

function config(...providers: ReadonlyArray<ReturnType<typeof provider>>) {
  return { providers } as unknown as ServerConfig;
}

// ProviderInstanceId is a branded string; tests build selections through here.
function selection(instanceId: string, model: string): ModelSelection {
  return { instanceId, model } as unknown as ModelSelection;
}

const CODEX = provider("codex-1", "codex", ["gpt-5.4", "gpt-5.6"]);
const CLAUDE = provider("claude-1", "claudeAgent", ["opus-5"]);

describe("model picker", () => {
  it("reports loading rather than an empty list while the config is null", () => {
    const model = buildModelPickerModel({
      serverConfig: null,
      currentSelection: null,
      providerLocked: false,
    });
    expect(model.loading).toBe(true);
    expect(model.pillLabel).toBe("Loading…");
    expect(model.pillAccessibilityLabel).toBe("Model: loading.");
  });

  it("does not claim to be loading once a config with no providers arrives", () => {
    const model = buildModelPickerModel({
      serverConfig: config(),
      currentSelection: null,
      providerLocked: false,
    });
    expect(model.loading).toBe(false);
    expect(model.groups).toEqual([]);
  });

  it("groups models by provider and marks the current one selected", () => {
    const model = buildModelPickerModel({
      serverConfig: config(CODEX, CLAUDE),
      currentSelection: selection("codex-1", "gpt-5.6"),
      providerLocked: false,
    });
    expect(model.groups.map((group) => group.providerKey)).toEqual(["codex-1", "claude-1"]);
    expect(model.groups[0]?.providerDriver).toBe("codex");
    const selected = model.groups
      .flatMap((group) => group.entries)
      .filter((entry) => entry.selected);
    expect(selected.map((entry) => entry.key)).toEqual(["codex-1:gpt-5.6"]);
    expect(model.pillLabel).toBe("GPT-5.6");
    expect(model.pillProviderDriver).toBe("codex");
  });

  it("locks a started thread to its provider without hiding the others", () => {
    const model = buildModelPickerModel({
      serverConfig: config(CODEX, CLAUDE),
      currentSelection: selection("codex-1", "gpt-5.4"),
      providerLocked: true,
    });
    expect(model.lockedProviderKey).toBe("codex-1");
    expect(model.lockNotice).toContain("become idle");

    const codex = model.groups.find((group) => group.providerKey === "codex-1");
    const claude = model.groups.find((group) => group.providerKey === "claude-1");
    // Same-provider models stay switchable...
    expect(codex?.entries.every((entry) => !entry.disabled)).toBe(true);
    // ...the other provider is visible but refused, with a stated reason.
    expect(claude?.entries.every((entry) => entry.disabled)).toBe(true);
    expect(claude?.entries[0]?.disabledReason).toContain("become idle");
  });

  it("leaves everything switchable when the thread has not started", () => {
    const model = buildModelPickerModel({
      serverConfig: config(CODEX, CLAUDE),
      currentSelection: selection("codex-1", "gpt-5.4"),
      providerLocked: false,
    });
    expect(model.lockedProviderKey).toBeNull();
    expect(model.groups.flatMap((g) => g.entries).every((entry) => !entry.disabled)).toBe(true);
  });

  it("filters by model and provider name, and drops emptied groups", () => {
    const model = buildModelPickerModel({
      serverConfig: config(CODEX, CLAUDE),
      currentSelection: null,
      providerLocked: false,
      query: "opus",
    });
    expect(model.groups.map((group) => group.providerKey)).toEqual(["claude-1"]);
    expect(model.emptyForQuery).toBe(false);
  });

  it("distinguishes a query that matched nothing from having no models", () => {
    const noMatch = buildModelPickerModel({
      serverConfig: config(CODEX),
      currentSelection: null,
      providerLocked: false,
      query: "zzzz",
    });
    expect(noMatch.emptyForQuery).toBe(true);

    const noModels = buildModelPickerModel({
      serverConfig: config(),
      currentSelection: null,
      providerLocked: false,
    });
    expect(noModels.emptyForQuery).toBe(false);
  });
});

describe("resolveModelPickerSelection", () => {
  const model = buildModelPickerModel({
    serverConfig: config(CODEX, CLAUDE),
    currentSelection: selection("codex-1", "gpt-5.4"),
    providerLocked: true,
  });

  it("returns the selection for an enabled, unselected entry", () => {
    expect(resolveModelPickerSelection(model, "codex-1:gpt-5.6")).toMatchObject({
      instanceId: "codex-1",
      model: "gpt-5.6",
    });
  });

  it("refuses a locked-out provider even if the UI let the tap through", () => {
    expect(resolveModelPickerSelection(model, "claude-1:opus-5")).toBeNull();
  });

  it("ignores the already-selected entry and unknown keys", () => {
    expect(resolveModelPickerSelection(model, "codex-1:gpt-5.4")).toBeNull();
    expect(resolveModelPickerSelection(model, "nope")).toBeNull();
  });
});

describe("legacy models and update notices", () => {
  const model = (
    slug: string,
    name: string,
    flags: { isLegacy?: boolean; isCustom?: boolean },
  ) => ({
    slug,
    name,
    isCustom: flags.isCustom ?? false,
    ...(flags.isLegacy === undefined ? {} : { isLegacy: flags.isLegacy }),
    capabilities: null,
  });
  const LEGACY_CLAUDE = {
    ...provider("claude-1", "claudeAgent", []),
    models: [
      model("claude-opus-4-6", "Claude Opus 4.6", { isLegacy: true }),
      model("claude-opus-5", "Claude Opus 5", {}),
      model("claude-haiku-4-5", "Claude Haiku 4.5", { isLegacy: true }),
      model("claude-sonnet-5", "Claude Sonnet 5", { isLegacy: false }),
      // Custom and proxy models never fold, whatever they carry.
      model("proxy/sonnet-4", "Proxy Sonnet 4", { isLegacy: true, isCustom: true }),
    ],
    updateRequiredModels: [
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" },
    ],
  };
  const ALL_LEGACY_CODEX = {
    ...provider("codex-1", "codex", []),
    models: [
      model("gpt-5.2", "GPT-5.2", { isLegacy: true }),
      model("gpt-5.1", "GPT-5.1", { isLegacy: true }),
    ],
  };
  const keys = (entries: ReadonlyArray<{ readonly key: string }>) =>
    entries.map((entry) => entry.key);
  const picker = (
    query = "",
    current = selection("claude-1", "claude-opus-5"),
    lockedProviderKey?: string,
  ) =>
    buildModelPickerModel({
      serverConfig: config(LEGACY_CLAUDE, ALL_LEGACY_CODEX),
      currentSelection: current,
      query,
      ...(lockedProviderKey ? { lockedProviderKey } : {}),
    });
  const claudeGroup = (model: ReturnType<typeof picker>) =>
    model.groups.find((group) => group.providerKey === "claude-1");

  it("folds each group's legacy models after its current ones, in order", () => {
    const claude = claudeGroup(picker());
    expect(keys(claude?.entries ?? [])).toEqual([
      "claude-1:claude-opus-5",
      "claude-1:claude-sonnet-5",
      "claude-1:proxy/sonnet-4",
    ]);
    expect(keys(claude?.legacyEntries ?? [])).toEqual([
      "claude-1:claude-opus-4-6",
      "claude-1:claude-haiku-4-5",
    ]);
    // A group whose models are all legacy has nothing to fold them under.
    const codex = picker().groups.find((group) => group.providerKey === "codex-1");
    expect(keys(codex?.entries ?? [])).toEqual(["codex-1:gpt-5.2", "codex-1:gpt-5.1"]);
    expect(codex?.legacyEntries).toEqual([]);
  });

  it("lists matching legacy models inline while searching", () => {
    const claude = claudeGroup(picker("4.6"));
    expect(keys(claude?.entries ?? [])).toEqual(["claude-1:claude-opus-4-6"]);
    expect(claude?.legacyEntries).toEqual([]);
  });

  it("keeps a selected legacy model in the current list", () => {
    const model = picker("", selection("claude-1", "claude-haiku-4-5"));
    const claude = claudeGroup(model);
    expect(keys(claude?.entries ?? [])).toContain("claude-1:claude-haiku-4-5");
    expect(claude?.entries.find((entry) => entry.selected)?.key).toBe("claude-1:claude-haiku-4-5");
    expect(keys(claude?.legacyEntries ?? [])).toEqual(["claude-1:claude-opus-4-6"]);
    expect(model.pillLabel).toBe("Haiku 4.5");
  });

  it("resolves a tap on a folded legacy model, and keeps the provider lock on it", () => {
    expect(resolveModelPickerSelection(picker(), "claude-1:claude-opus-4-6")).toMatchObject({
      instanceId: "claude-1",
      model: "claude-opus-4-6",
    });
    expect(keys(listModelPickerEntries(picker()))).toContain("claude-1:claude-haiku-4-5");

    const locked = picker("", selection("codex-1", "gpt-5.1"), "codex-1");
    expect(claudeGroup(locked)?.legacyEntries.every((entry) => entry.disabled)).toBe(true);
    expect(resolveModelPickerSelection(locked, "claude-1:claude-opus-4-6")).toBeNull();
  });

  it("names the update that unlocks a model under its group", () => {
    expect(claudeGroup(picker())?.updateRequiredNotice).toBe(
      "Update Claude Code to v2.1.257 or newer to use Claude Fable 5.1.",
    );
    expect(
      picker().groups.find((group) => group.providerKey === "codex-1")?.updateRequiredNotice,
    ).toBeNull();
    // Without provider snapshots there is nothing to say.
    const fromOptions = buildModelPickerModelFromOptions({
      modelOptions: buildModelOptions(config(LEGACY_CLAUDE), null),
      currentSelection: null,
    });
    expect(fromOptions.groups[0]?.updateRequiredNotice).toBeNull();
  });

  it("keeps a group for a search only its notice matches", () => {
    const fable = picker("fable");
    expect(fable.groups.map((group) => group.providerKey)).toEqual(["claude-1"]);
    expect(claudeGroup(fable)?.entries).toEqual([]);
    expect(claudeGroup(fable)?.updateRequiredNotice).toContain("Claude Fable 5.1");
    expect(fable.emptyForQuery).toBe(true);

    const sonnet = picker("sonnet 5");
    expect(keys(claudeGroup(sonnet)?.entries ?? [])).toEqual(["claude-1:claude-sonnet-5"]);
    expect(claudeGroup(sonnet)?.updateRequiredNotice).toBeNull();
    expect(sonnet.emptyForQuery).toBe(false);

    const none = picker("zzzz");
    expect(none.groups).toEqual([]);
    expect(none.emptyForQuery).toBe(true);
  });
});

describe("model options", () => {
  const CAPS = {
    reasoningEfforts: ["low", "medium", "high"],
    supportsFastMode: true,
  } as never;

  function withCaps(models: ReadonlyArray<string>) {
    return {
      instanceId: "claude-1",
      driver: "claudeAgent",
      displayName: undefined,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: models.map((slug) => ({ slug, name: slug, capabilities: CAPS })),
    } as unknown as ReturnType<typeof provider>;
  }

  it("has no rail when the selected model declares no options", () => {
    // The state that matters: a model without options must get NO rail rather
    // than an empty or disabled one.
    const model = buildModelPickerModel({
      serverConfig: config(CODEX),
      currentSelection: selection("codex-1", "gpt-5.4"),
      providerLocked: false,
    });
    expect(model.options).toEqual([]);
    expect(model.hasOptionRail).toBe(false);
  });

  it("carries capabilities onto every entry so options can be derived", () => {
    const model = buildModelPickerModel({
      serverConfig: config(withCaps(["opus-5"])),
      currentSelection: selection("claude-1", "opus-5"),
      providerLocked: false,
    });
    const entry = model.groups.flatMap((group) => group.entries)[0];
    expect(entry?.capabilities).not.toBeUndefined();
  });

  it("reports no rail while the config is still loading", () => {
    const model = buildModelPickerModel({
      serverConfig: null,
      currentSelection: selection("claude-1", "opus-5"),
      providerLocked: false,
    });
    expect(model.hasOptionRail).toBe(false);
  });
});

describe("shortChoiceLabel", () => {
  it("abbreviates every reasoning level a driver actually declares", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["none", "None"],
      ["minimal", "Min"],
      ["low", "Low"],
      ["medium", "Med"],
      ["high", "High"],
      ["xhigh", "XHigh"],
      ["max", "Max"],
      ["ultra", "Ultra"],
      ["ultracode", "UCode"],
      ["ultrathink", "UThink"],
    ];
    for (const [id, expected] of cases) {
      expect(shortChoiceLabel({ id, label: "ignored" })).toBe(expected);
    }
  });

  it("keys off the id, not the label", () => {
    // Ids are normalized by every driver; labels are upstream text that can
    // change, so matching on them would silently stop working.
    expect(shortChoiceLabel({ id: "ultracode", label: "Something Else Entirely" })).toBe("UCode");
    expect(shortChoiceLabel({ id: "XHIGH", label: "whatever" })).toBe("XHigh");
  });

  it("passes short labels through untouched", () => {
    expect(shortChoiceLabel({ id: "unknown-id", label: "272K" })).toBe("272K");
    expect(shortChoiceLabel({ id: "unknown-id", label: "Build" })).toBe("Build");
  });

  it("compresses a two-word label to five characters plus an initial", () => {
    expect(shortChoiceLabel({ id: "ultra-deep", label: "Ultra Deep" })).toBe("UltraD");
  });

  it("truncates a long single word", () => {
    expect(shortChoiceLabel({ id: "nope", label: "Exhaustive" })).toBe("Exhaus");
  });

  it("never exceeds six characters, whatever it is given", () => {
    for (const label of ["Extremely Long Reasoning Level", "aaaaaaaaaaaaaaa", "A B C D"]) {
      expect(shortChoiceLabel({ id: "x", label }).length).toBeLessThanOrEqual(6);
    }
  });
});

describe("composer chip summary", () => {
  const CAPS = { reasoningEfforts: ["low", "medium", "high"], supportsFastMode: true } as never;
  const withCaps = () =>
    ({
      instanceId: "claude-1",
      driver: "claudeAgent",
      displayName: undefined,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "opus-5", name: "Opus 5", capabilities: CAPS }],
    }) as unknown as ReturnType<typeof provider>;

  it("shows nothing extra when the model declares no options", () => {
    const model = buildModelPickerModel({
      serverConfig: config(CODEX),
      currentSelection: selection("codex-1", "gpt-5.4"),
      providerLocked: false,
    });
    // A placeholder would be worse than silence: there is no level to report.
    expect(model.pillReasoningLabel).toBeNull();
    expect(model.pillFastEnabled).toBe(false);
  });

  it("keeps the chip quiet while the config is loading", () => {
    const model = buildModelPickerModel({
      serverConfig: null,
      currentSelection: selection("claude-1", "opus-5"),
      providerLocked: false,
    });
    expect(model.pillReasoningLabel).toBeNull();
    expect(model.pillFastEnabled).toBe(false);
  });

  it("speaks the full reasoning label, not the rail abbreviation", () => {
    // "UCode" read aloud is meaningless; the chip may abbreviate, the label may not.
    const model = buildModelPickerModel({
      serverConfig: config(withCaps()),
      currentSelection: selection("claude-1", "opus-5"),
      providerLocked: false,
    });
    if (model.pillReasoningLabel !== null) {
      expect(model.pillAccessibilityLabel).not.toContain(model.pillReasoningLabel + ".");
    }
    expect(model.pillAccessibilityLabel).toContain("Model:");
  });
});

describe("capability-driven reasoning and Fast mode", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      { id: "fast", label: "Fast Mode", type: "boolean", currentValue: false },
    ],
  } as ModelCapabilities;

  it("shows declared choices and selects the provider default", () => {
    const controls = buildModelOptionControls(selection("codex-1", "gpt-5.6"), capabilities);
    expect(
      controls[0]?.choices.filter((choice) => choice.selected).map((choice) => choice.id),
    ).toEqual(["high"]);
    expect(controls[1]).toMatchObject({ id: "fast", enabled: false });
    expect(buildModelOptionControls(selection("codex-1", "gpt-5.6"), null)).toEqual([]);
    expect(
      buildModelOptionControls(selection("codex-1", "gpt-5.6"), {
        optionDescriptors: [],
      } as unknown as ModelCapabilities),
    ).toEqual([]);
  });

  it("updates reasoning and Fast mode independently without changing the selected model", () => {
    let current = selection("codex-1", "gpt-5.6");
    current = applyModelOption(current, capabilities, "fast", true);
    current = applyModelOption(current, capabilities, "reasoning", "low");
    expect(current).toEqual({
      instanceId: "codex-1",
      model: "gpt-5.6",
      options: [
        { id: "reasoning", value: "low" },
        { id: "fast", value: true },
      ],
    });
    expect(applyModelOption(current, capabilities, "reasoning", "unsupported")).toBe(current);
    expect(applyModelOption(current, capabilities, "fast", "true")).toBe(current);
    expect(applyModelOption(current, capabilities, "missing", true)).toBe(current);
    expect(applyModelOption(current, capabilities, "fast", false).options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fast", value: false },
    ]);
  });
});

describe("model pill Fast mode notice", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
    ],
  } as unknown as ModelCapabilities;
  const claude = {
    ...CLAUDE,
    models: [{ slug: "opus-5", name: "Opus 5", capabilities }],
  } as unknown as ReturnType<typeof provider>;
  const pill = (fast: boolean) =>
    buildModelPickerModel({
      serverConfig: config(claude),
      currentSelection: {
        ...selection("claude-1", "opus-5"),
        options: [{ id: "fastMode", value: fast }],
      } as ModelSelection,
    });

  it("does not read another on/off option as Fast", () => {
    const thinkingOnly = {
      ...CLAUDE,
      models: [
        {
          slug: "haiku-4-5",
          name: "Haiku 4.5",
          capabilities: {
            optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
          },
        },
      ],
    } as unknown as ReturnType<typeof provider>;
    const model = buildModelPickerModel({
      serverConfig: config(thinkingOnly),
      currentSelection: {
        ...selection("claude-1", "haiku-4-5"),
        options: [{ id: "thinking", value: true }],
      } as ModelSelection,
    });
    expect(model.pillFastEnabled).toBe(false);
    expect(model.pillAccessibilityLabel).not.toContain("Thinking on.");
  });

  it("keeps the filled bolt and the plain label without a notice", () => {
    const model = pill(true);
    expect(resolveModelPillFastMode(model, null)).toEqual({
      icon: "bolt.fill",
      muted: false,
      accessibilityLabel: model.pillAccessibilityLabel,
    });
    expect(resolveModelPillFastMode(pill(false), undefined).icon).toBeUndefined();
  });

  it("strikes the bolt through and says why when Claude Code pauses or refuses Fast", () => {
    const model = pill(true);
    expect(model.pillAccessibilityLabel).toContain("Fast Mode on.");
    const blocked = resolveModelPillFastMode(model, {
      kind: "blocked",
      label: "Fast unavailable",
      detail: "Claude Code only serves Fast mode on a direct Anthropic connection.",
    });
    expect(blocked.icon).toBe("bolt.slash");
    expect(blocked.muted).toBe(true);
    expect(blocked.accessibilityLabel).toBe(
      `${model.pillAccessibilityLabel} Fast unavailable. Claude Code only serves Fast mode on a direct Anthropic connection.`,
    );
    const cooldown = resolveModelPillFastMode(model, {
      kind: "cooldown",
      label: "Fast paused",
      detail: "A rate limit paused Fast mode for now.",
    });
    expect(cooldown).toMatchObject({ icon: "bolt.slash", muted: true });
    expect(cooldown.accessibilityLabel).toContain("Fast paused.");
  });

  it("shows an outline bolt when Claude Code's own settings turned Fast on", () => {
    const model = pill(false);
    expect(model.pillAccessibilityLabel).not.toContain("Fast Mode on.");
    const external = resolveModelPillFastMode(model, {
      kind: "external",
      label: "Fast on",
      detail: "Claude Code's own settings turned Fast mode on.",
    });
    expect(external).toEqual({
      icon: "bolt",
      muted: false,
      accessibilityLabel: `${model.pillAccessibilityLabel} Fast on. Claude Code's own settings turned Fast mode on.`,
    });
  });
});
