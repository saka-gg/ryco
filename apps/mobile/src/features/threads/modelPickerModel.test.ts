import type { ModelSelection, ServerConfig, ModelCapabilities } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelPickerModel,
  buildModelOptionControls,
  applyModelOption,
  resolveModelPickerSelection,
  shortChoiceLabel,
} from "./modelPickerModel";

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
