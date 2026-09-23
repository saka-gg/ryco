import {
  indexModelFavorites,
  resolveModelFavoriteForRow,
  getModelFavoriteEffortLabel,
} from "./modelFavorites";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import {
  applyModelFavorite,
  createModelFavorite,
  modelFavoriteKey,
  toggleModelFavorite,
  updateInstanceModelFavorites,
} from "./modelFavorites";

const provider = ProviderInstanceId.make("codex_personal");
const base = { provider, model: "vendor:model" };
const low = { ...base, reasoningEffort: "low" };
const high = { ...base, reasoningEffort: "high" };
const caps = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
    { id: "fastMode", label: "Fast", type: "boolean" },
    {
      id: "serviceTier",
      label: "Tier",
      type: "select",
      options: [{ id: "priority", label: "Priority" }],
    },
  ],
});
const current: ModelSelection = {
  instanceId: provider,
  model: base.model,
  options: [
    { id: "reasoningEffort", value: "low" },
    { id: "fastMode", value: true },
    { id: "serviceTier", value: "priority" },
  ],
};

describe("model and effort favorites", () => {
  it("keeps legacy, multiple efforts and same-driver instances distinct and ordered", () => {
    const other = { ...high, provider: ProviderInstanceId.make("codex") };
    const favorites = toggleModelFavorite([base, low, low, other], high);
    expect(favorites).toEqual([base, low, other, high]);
    expect(toggleModelFavorite(favorites, low)).toEqual([base, other, high]);
    expect(new Set(favorites.map(modelFavoriteKey)).size).toBe(4);
  });
  it("captures only supported effort and restores it without overwriting other options", () => {
    expect(createModelFavorite(current, caps)).toEqual(low);
    expect(applyModelFavorite(high, current, caps)).toEqual({
      ...current,
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
        { id: "serviceTier", value: "priority" },
      ],
    });
    expect(applyModelFavorite(base, current, caps)).toEqual(current);
  });
  it("normalizes stale effort, drops unsupported options, and never invents capabilities", () => {
    expect(applyModelFavorite({ ...base, reasoningEffort: "ultra" }, current, caps)).toEqual(
      current,
    );
    expect(applyModelFavorite(high, current, null)).toEqual({
      instanceId: provider,
      model: base.model,
    });
    const noReasoning = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }],
    });
    expect(createModelFavorite(current, noReasoning)).toEqual(base);
    expect(applyModelFavorite(high, current, noReasoning).options).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
  it("supports Claude effort but does not save prompt-injected or empty select choices", () => {
    const claude = createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });
    expect(applyModelFavorite(high, current, claude).options).toEqual([
      { id: "effort", value: "high" },
    ]);
    expect(
      applyModelFavorite({ ...base, reasoningEffort: "ultrathink" }, current, claude).options,
    ).toEqual([{ id: "effort", value: "high" }]);
    const empty = createModelCapabilities({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [],
          currentValue: "retired",
        },
      ],
    });
    expect(createModelFavorite(current, empty)).toEqual(base);
    expect(applyModelFavorite(high, current, empty).options).toBeUndefined();
  });
  it.each(["reasoning", "variant"])(
    "restores %s without selecting an agent or context window",
    (id) => {
      const capabilities = createModelCapabilities({
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [
              { id: "build", label: "Build" },
              { id: "plan", label: "Plan" },
            ],
          },
          {
            id,
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      });
      const selection = {
        ...current,
        options: [
          { id: "agent", value: "plan" },
          { id, value: "low" },
        ],
      };
      expect(createModelFavorite(selection, capabilities)).toEqual(low);
      expect(applyModelFavorite(high, selection, capabilities).options).toEqual([
        { id: "agent", value: "plan" },
        { id, value: "high" },
      ]);
    },
  );

  it("preserves preset metadata and ordering during model-level settings edits", () => {
    const other = { ...high, provider: ProviderInstanceId.make("codex") };
    expect(updateInstanceModelFavorites([other, low, high], provider, [base.model, "new"])).toEqual(
      [other, low, high, { provider, model: "new" }],
    );
    expect(updateInstanceModelFavorites([other, low, high], provider, [])).toEqual([other]);
  });
});

describe("favorite row identity and labels", () => {
  it("recognizes legacy stars independently of current effort and removes collapsed old-reader duplicates", () => {
    const index = indexModelFavorites([base, base, low, high]);
    expect(resolveModelFavoriteForRow(high, index)).toEqual(base);
    expect(
      toggleModelFavorite([base, base, low, high], resolveModelFavoriteForRow(high, index)),
    ).toEqual([low, high]);
    expect(index.byKey.size).toBe(3);
  });
  it("keeps distinct efforts selectable and uses declared labels rather than raw ids", () => {
    const index = indexModelFavorites([low, high]);
    expect(resolveModelFavoriteForRow(low, index)).toEqual(low);
    expect(
      resolveModelFavoriteForRow({ ...base, reasoningEffort: "medium" }, index).reasoningEffort,
    ).toBe("medium");
    expect(getModelFavoriteEffortLabel(high, caps)).toBe("High");
    expect(getModelFavoriteEffortLabel(base, caps)).toBeUndefined();
    expect(getModelFavoriteEffortLabel({ ...base, reasoningEffort: "retired" }, caps)).toBe(
      "retired (unavailable)",
    );
  });
  it("never copies same-id options from a foreign instance when a caller lacks a target selection", () => {
    expect(
      applyModelFavorite(low, { ...current, instanceId: ProviderInstanceId.make("other") }, caps)
        .options,
    ).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });
});
