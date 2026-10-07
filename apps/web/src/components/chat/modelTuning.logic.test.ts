import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
} from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  getTuningScale,
  isTuningDescriptor,
  reasoningTone,
  resetTuningDescriptors,
  resolveModelTuning,
  stepTuningScale,
  summarizeModelTuning,
} from "./modelTuning.logic";

const CLAUDE_EFFORT = {
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultracode" },
  ],
};
const FAST = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };
const CONTEXT = {
  id: "contextWindow",
  label: "Context Window",
  type: "select" as const,
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M", isDefault: true },
  ],
};
const AGENT = {
  id: "agent",
  label: "Agent",
  type: "select" as const,
  options: [
    { id: "build", label: "Build", isDefault: true },
    { id: "plan", label: "Plan" },
  ],
};

const opus = createModelCapabilities({ optionDescriptors: [CLAUDE_EFFORT, FAST, CONTEXT] });

describe("resolveModelTuning", () => {
  it("returns null when the model has nothing for the dial to own", () => {
    const caps = createModelCapabilities({ optionDescriptors: [AGENT] });
    expect(resolveModelTuning({ caps, selections: undefined, prompt: "" })).toBeNull();
  });

  it("resolves effort, fast mode and context window at their defaults", () => {
    const tuning = resolveModelTuning({ caps: opus, selections: undefined, prompt: "" });
    expect(tuning?.effort?.id).toBe("effort");
    expect(tuning?.effortValue).toBe("high");
    expect(tuning?.speedTiers).toEqual(["standard", "fast"]);
    expect(tuning?.speed).toBe("standard");
    expect(tuning?.contextWindow?.id).toBe("contextWindow");
    expect(tuning?.isDefault).toBe(true);
  });

  it("finds the reasoning descriptor under every provider's id", () => {
    for (const id of ["effort", "reasoningEffort", "reasoning"]) {
      const caps = createModelCapabilities({ optionDescriptors: [{ ...CLAUDE_EFFORT, id }] });
      expect(resolveModelTuning({ caps, selections: undefined, prompt: "" })?.effort?.id).toBe(id);
    }
  });

  it("stops being default once any dial-owned option moves, but not for agent changes", () => {
    const caps = createModelCapabilities({ optionDescriptors: [CLAUDE_EFFORT, FAST, AGENT] });
    expect(
      resolveModelTuning({ caps, selections: [{ id: "fastMode", value: true }], prompt: "" })
        ?.isDefault,
    ).toBe(false);
    expect(
      resolveModelTuning({ caps, selections: [{ id: "fastMode", value: false }], prompt: "" })
        ?.isDefault,
    ).toBe(true);
    expect(
      resolveModelTuning({ caps, selections: [{ id: "agent", value: "plan" }], prompt: "" })
        ?.isDefault,
    ).toBe(true);
  });

  it("reports prompt-controlled ultrathink as the effective effort", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        {
          ...CLAUDE_EFFORT,
          options: [...CLAUDE_EFFORT.options, { id: "ultrathink", label: "Ultrathink" }],
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });
    const prefixed = resolveModelTuning({
      caps,
      selections: undefined,
      prompt: "Ultrathink:\nfix",
    });
    expect(prefixed?.effortValue).toBe("ultrathink");
    expect(prefixed?.ultrathinkInBodyText).toBe(false);
    expect(prefixed?.isDefault).toBe(false);
    const inBody = resolveModelTuning({ caps, selections: undefined, prompt: "please ultrathink" });
    expect(inBody?.ultrathinkInBodyText).toBe(true);
  });
});

describe("resetTuningDescriptors", () => {
  it("restores dial-owned defaults and keeps the agent selection", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [CLAUDE_EFFORT, FAST, CONTEXT, AGENT],
    });
    const tuning = resolveModelTuning({
      caps,
      selections: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
        { id: "contextWindow", value: "200k" },
        { id: "agent", value: "plan" },
      ],
      prompt: "",
    });
    const reset = resetTuningDescriptors({ caps, descriptors: tuning!.descriptors });
    expect(buildProviderOptionSelectionsFromDescriptors(reset)).toEqual([
      { id: "effort", value: "high" },
      { id: "contextWindow", value: "1m" },
      { id: "agent", value: "plan" },
    ]);
  });
});

describe("getTuningScale", () => {
  it("walks effort levels and lands on the current one", () => {
    const tuning = resolveModelTuning({
      caps: opus,
      selections: [{ id: "effort", value: "max" }],
      prompt: "",
    })!;
    const scale = getTuningScale(tuning)!;
    expect(scale.kind).toBe("effort");
    expect(scale.stops.map((stop) => stop.id)).toEqual(CLAUDE_EFFORT.options.map((o) => o.id));
    expect(scale.index).toBe(4);
    expect(stepTuningScale(scale, 1)).toBe(5);
    expect(stepTuningScale(scale, -10)).toBe(0);
  });

  it("returns null at either end of the scale", () => {
    const tuning = resolveModelTuning({
      caps: opus,
      selections: [{ id: "effort", value: "ultracode" }],
      prompt: "",
    })!;
    expect(stepTuningScale(getTuningScale(tuning)!, 1)).toBeNull();
  });

  it("falls back to a two-stop thinking scale for thinking-only models", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
      ],
    });
    const scale = getTuningScale(resolveModelTuning({ caps, selections: undefined, prompt: "" })!);
    expect(scale?.kind).toBe("thinking");
    expect(scale?.index).toBe(1);
  });

  it("has no scale for fast-mode-only models", () => {
    const caps = createModelCapabilities({ optionDescriptors: [FAST] });
    expect(getTuningScale(resolveModelTuning({ caps, selections: undefined, prompt: "" })!)).toBe(
      null,
    );
  });
});

describe("summarizeModelTuning", () => {
  it("summarizes effort, fast mode and a selectable context window", () => {
    const tuning = resolveModelTuning({
      caps: opus,
      selections: [
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: true },
      ],
      prompt: "",
    });
    expect(summarizeModelTuning(tuning)).toEqual({
      level: { id: "xhigh", label: "XHigh", index: 3 },
      speed: "fast",
      contextWindowLabel: "1M",
    });
  });

  it("keeps the advertised label for an unrecognized future level", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        { ...CLAUDE_EFFORT, options: [{ id: "ultra-deep", label: "Ultra Deep", isDefault: true }] },
      ],
    });
    expect(
      summarizeModelTuning(resolveModelTuning({ caps, selections: undefined, prompt: "" }))?.level
        ?.label,
    ).toBe("Ultra Deep");
  });

  it("shows thinking only while it is on", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
    });
    const on = resolveModelTuning({
      caps,
      selections: [{ id: "thinking", value: true }],
      prompt: "",
    });
    const off = resolveModelTuning({
      caps,
      selections: [{ id: "thinking", value: false }],
      prompt: "",
    });
    expect(summarizeModelTuning(on)?.level?.label).toBe("Thinking");
    expect(summarizeModelTuning(off)?.level).toBeNull();
  });
});

describe("tuning ownership and tones", () => {
  it("owns effort, context, fast mode and thinking but not agent or variant", () => {
    expect(isTuningDescriptor(CLAUDE_EFFORT)).toBe(true);
    expect(isTuningDescriptor(CONTEXT)).toBe(true);
    expect(isTuningDescriptor(FAST)).toBe(true);
    expect(isTuningDescriptor({ id: "thinking", label: "Thinking", type: "boolean" })).toBe(true);
    expect(isTuningDescriptor(AGENT)).toBe(false);
    expect(isTuningDescriptor({ ...AGENT, id: "variant" })).toBe(false);
  });

  it("maps levels to colour families and neutralizes unknown ones", () => {
    expect(reasoningTone("minimal")).toBe("low");
    expect(reasoningTone("ultrathink")).toBe("ultra");
    expect(reasoningTone("ultracode")).toBe("ultracode");
    expect(reasoningTone("ultra-deep")).toBe("low");
    expect(reasoningTone(null)).toBe("low");
  });
});
