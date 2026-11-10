import { ProviderInstanceId, type ModelSelection } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  applyComposerTuningChange,
  composerCaptionLabel,
  composerControlsCaution,
  composerPlaceholder,
  composerPrimaryAction,
  composerTriggerTraits,
  isComposerFooterCompact,
  reasoningToneColorVar,
  resolveComposerTuning,
  speedToneColorVar,
  summarizeComposerTuning,
} from "./composerFooterModel";
import { buildModelPickerModelFromOptions } from "./modelPickerModel";

const instance = ProviderInstanceId.make("claudeAgent");
const caps = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
    },
    { id: "fastMode", label: "Fast mode", type: "boolean" },
    {
      id: "contextWindow",
      label: "Context window",
      type: "select",
      options: [
        { id: "200k", label: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ],
    },
  ],
});
const selection: ModelSelection = {
  instanceId: instance,
  model: "opus",
  options: [
    { id: "effort", value: "high" },
    { id: "contextWindow", value: "1m" },
  ],
};
const model = buildModelPickerModelFromOptions({
  currentSelection: selection,
  modelOptions: [
    {
      key: `${instance}:opus`,
      label: "Opus 5.5",
      subtitle: "Claude",
      providerKey: instance,
      providerLabel: "Claude",
      providerDriver: "claudeAgent",
      isDefault: false,
      isLegacy: false,
      isCustom: false,
      capabilities: caps,
      selection,
    },
  ],
});

describe("composer footer layout", () => {
  it("folds the mode controls below the desktop's 620pt breakpoint", () => {
    expect(isComposerFooterCompact(370)).toBe(true);
    expect(isComposerFooterCompact(619)).toBe(true);
    expect(isComposerFooterCompact(620)).toBe(false);
    // Unmeasured, it stays expanded like the desktop footer.
    expect(isComposerFooterCompact(null)).toBe(false);
  });

  it("uses the desktop placeholders, an approval redirect's own first", () => {
    expect(composerPlaceholder({ running: false })).toBe(
      "Ask for follow-up changes or attach images",
    );
    expect(composerPlaceholder({ running: true })).toBe("Queue a follow-up");
    expect(composerPlaceholder({ running: true, override: "Redirect" })).toBe("Redirect");
  });

  it("sends, stops a running turn, and queues typed content while one runs", () => {
    expect(composerPrimaryAction({ hasContent: false, running: false, canStop: true })).toBe(
      "send",
    );
    expect(composerPrimaryAction({ hasContent: true, running: false, canStop: true })).toBe("send");
    expect(composerPrimaryAction({ hasContent: false, running: true, canStop: true })).toBe("stop");
    expect(composerPrimaryAction({ hasContent: true, running: true, canStop: true })).toBe("queue");
    expect(composerPrimaryAction({ hasContent: false, running: true, canStop: false })).toBe(
      "send",
    );
  });

  it("tints the ellipsis only under Full access", () => {
    expect(composerControlsCaution("full-access")).toBe(true);
    expect(composerControlsCaution("auto")).toBe(false);
  });

  it("names the model and its effort for the context card", () => {
    expect(composerCaptionLabel({ pillLabel: "Opus 5.5", pillReasoningLabel: "High" })).toBe(
      "Opus 5.5 · High",
    );
    expect(composerCaptionLabel({ pillLabel: "GPT-5.6", pillReasoningLabel: null })).toBe(
      "GPT-5.6",
    );
  });
});

describe("composer model pill and dial", () => {
  const tuning = resolveComposerTuning({ model, selection, prompt: "" })!;

  it("reads the effort in its tone, and drops the context tag when compact", () => {
    const summary = summarizeComposerTuning(tuning);
    expect(composerTriggerTraits(summary, false)).toEqual({
      level: { label: "High", tone: "high" },
      speed: "standard",
      contextWindowLabel: "1M",
    });
    expect(composerTriggerTraits(summary, true)?.contextWindowLabel).toBeNull();
    expect(reasoningToneColorVar("high")).toBe("--color-reasoning-high");
    expect(speedToneColorVar("fast")).toBe("--color-fast-mode");
    expect(speedToneColorVar("standard")).toBeNull();
  });

  it("writes effort, speed and context window onto the selection", () => {
    const lowered = applyComposerTuningChange({
      model,
      selection,
      tuning,
      change: { kind: "effort", value: "low" },
    }).options;
    expect(lowered).toContainEqual({ id: "effort", value: "low" });
    expect(lowered).toContainEqual({ id: "contextWindow", value: "1m" });
    expect(
      applyComposerTuningChange({
        model,
        selection,
        tuning,
        change: { kind: "speed", tier: "fast" },
      }).options,
    ).toContainEqual({ id: "fastMode", value: true });
    expect(
      applyComposerTuningChange({
        model,
        selection,
        tuning,
        change: { kind: "contextWindow", value: "200k" },
      }).options,
    ).toContainEqual({ id: "contextWindow", value: "200k" });
  });

  it("ignores an effort the model does not offer and resets to the model's defaults", () => {
    expect(
      applyComposerTuningChange({
        model,
        selection,
        tuning,
        change: { kind: "effort", value: "ultra" },
      }),
    ).toBe(selection);
    const reset = applyComposerTuningChange({
      model,
      selection,
      tuning,
      change: { kind: "reset" },
    });
    expect(reset.options).toContainEqual({ id: "effort", value: "medium" });
    expect(reset.options).toContainEqual({ id: "contextWindow", value: "200k" });
  });
});
