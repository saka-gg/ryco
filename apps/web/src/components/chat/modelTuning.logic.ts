import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@ryco/contracts";
import {
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@ryco/shared/model";

export type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
export type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Reasoning effort descriptor ids: Claude → "effort", Codex → "reasoningEffort", Cursor → "reasoning". */
export const REASONING_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  "effort",
  "reasoningEffort",
  "reasoning",
]);

const ULTRATHINK_PREFIX_PATTERN = /^Ultrathink:\s*/i;

/**
 * Whether the model picker's tuning dial owns this descriptor. Everything the
 * dial does not own (agent, OpenCode variants, future selects) stays a
 * composer chip.
 */
export function isTuningDescriptor(descriptor: ProviderOptionDescriptor): boolean {
  if (descriptor.type === "select") {
    return REASONING_DESCRIPTOR_IDS.has(descriptor.id) || descriptor.id === "contextWindow";
  }
  return descriptor.id === "fastMode" || descriptor.id === "thinking";
}

export interface ModelTuning {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  /** First select descriptor; the one prompt-injected ultrathink controls. */
  readonly primarySelectDescriptorId: string | undefined;
  readonly effort: SelectDescriptor | null;
  readonly thinking: BooleanDescriptor | null;
  readonly fastMode: BooleanDescriptor | null;
  readonly contextWindow: SelectDescriptor | null;
  /** The effort the turn will actually use, including prompt-controlled ultrathink. */
  readonly effortValue: string | null;
  readonly ultrathinkPromptControlled: boolean;
  /** "ultrathink" appears in the prompt body, so effort cannot be changed from the dial. */
  readonly ultrathinkInBodyText: boolean;
  /** Every dial-owned option sits at the model's default. */
  readonly isDefault: boolean;
}

function findSelect(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  predicate: (descriptor: SelectDescriptor) => boolean,
): SelectDescriptor | null {
  return (
    descriptors.find(
      (descriptor): descriptor is SelectDescriptor =>
        descriptor.type === "select" && predicate(descriptor),
    ) ?? null
  );
}

function findBoolean(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  id: string,
): BooleanDescriptor | null {
  return (
    descriptors.find(
      (descriptor): descriptor is BooleanDescriptor =>
        descriptor.type === "boolean" && descriptor.id === id,
    ) ?? null
  );
}

function normalizedValue(descriptor: ProviderOptionDescriptor): string | boolean {
  const value = getProviderOptionCurrentValue(descriptor);
  if (descriptor.type === "boolean") return value === true;
  return typeof value === "string" ? value : "";
}

export function resolveModelTuning(input: {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  prompt: string;
}): ModelTuning | null {
  const descriptors = getProviderOptionDescriptors({
    caps: input.caps,
    selections: input.selections,
  });
  const effort = findSelect(descriptors, (descriptor) =>
    REASONING_DESCRIPTOR_IDS.has(descriptor.id),
  );
  const contextWindow = findSelect(descriptors, (descriptor) => descriptor.id === "contextWindow");
  const fastMode = findBoolean(descriptors, "fastMode");
  const thinking = findBoolean(descriptors, "thinking");
  if (!effort && !contextWindow && !fastMode && !thinking) return null;

  const primarySelect = findSelect(descriptors, () => true);
  const ultrathinkPromptControlled =
    (primarySelect?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(input.prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled &&
    isClaudeUltrathinkPrompt(input.prompt.replace(ULTRATHINK_PREFIX_PATTERN, ""));

  const rawEffort = effort ? getProviderOptionCurrentValue(effort) : undefined;
  const effortValue =
    ultrathinkPromptControlled && effort?.id === primarySelect?.id
      ? "ultrathink"
      : typeof rawEffort === "string"
        ? rawEffort
        : null;

  const defaults = new Map(
    getProviderOptionDescriptors({ caps: input.caps }).map((descriptor) => [
      descriptor.id,
      normalizedValue(descriptor),
    ]),
  );
  const isDefault =
    !ultrathinkPromptControlled &&
    descriptors
      .filter(isTuningDescriptor)
      .every((descriptor) => defaults.get(descriptor.id) === normalizedValue(descriptor));

  return {
    descriptors,
    primarySelectDescriptorId: primarySelect?.id,
    effort,
    thinking,
    fastMode,
    contextWindow,
    effortValue,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    isDefault,
  };
}

/**
 * Descriptors with every dial-owned option back at the model default; options
 * the dial does not own (agent, variants) keep their current value.
 */
export function resetTuningDescriptors(input: {
  caps: ModelCapabilities;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const defaults = new Map(
    getProviderOptionDescriptors({ caps: input.caps }).map((descriptor) => [
      descriptor.id,
      descriptor,
    ]),
  );
  return input.descriptors.map((descriptor) => {
    if (!isTuningDescriptor(descriptor)) return descriptor;
    const fallback = defaults.get(descriptor.id);
    const { currentValue: _current, ...rest } = descriptor;
    return fallback?.currentValue === undefined
      ? (rest as ProviderOptionDescriptor)
      : ({ ...rest, currentValue: fallback.currentValue } as ProviderOptionDescriptor);
  });
}

export interface TuningStop {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

/** The ordered stops the dial travels across: effort levels, or thinking off/on. */
export interface TuningScale {
  readonly kind: "effort" | "thinking";
  readonly stops: ReadonlyArray<TuningStop>;
  readonly index: number;
}

export function getTuningScale(tuning: ModelTuning): TuningScale | null {
  if (tuning.effort && tuning.effort.options.length > 1) {
    const stops = tuning.effort.options.map((option) => ({
      id: option.id,
      label: option.label,
      isDefault: option.isDefault === true,
    }));
    const current = stops.findIndex((stop) => stop.id === tuning.effortValue);
    const fallback = stops.findIndex((stop) => stop.isDefault);
    return { kind: "effort", stops, index: current >= 0 ? current : Math.max(0, fallback) };
  }
  if (tuning.thinking) {
    return {
      kind: "thinking",
      stops: [
        { id: "off", label: "No thinking", isDefault: false },
        { id: "on", label: "Thinking", isDefault: false },
      ],
      index: tuning.thinking.currentValue === true ? 1 : 0,
    };
  }
  return null;
}

/** The stop index `delta` steps away, or null when already at that end. */
export function stepTuningScale(scale: TuningScale, delta: number): number | null {
  const next = Math.min(scale.stops.length - 1, Math.max(0, scale.index + delta));
  return next === scale.index ? null : next;
}

const SHORT_LEVEL_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

export interface ModelTuningSummary {
  /** Effort (or "thinking") shown in the composer pill; `index` orders changes. */
  readonly level: { readonly id: string; readonly label: string; readonly index: number } | null;
  readonly fastMode: boolean;
  /** Only present when the model offers a choice of context window. */
  readonly contextWindowLabel: string | null;
}

export function summarizeModelTuning(tuning: ModelTuning | null): ModelTuningSummary | null {
  if (!tuning) return null;
  let level: ModelTuningSummary["level"] = null;
  if (tuning.effort && tuning.effortValue) {
    const index = tuning.effort.options.findIndex((option) => option.id === tuning.effortValue);
    const optionLabel = tuning.effort.options[index]?.label;
    level = {
      id: tuning.effortValue,
      label: SHORT_LEVEL_LABELS[tuning.effortValue] ?? optionLabel ?? tuning.effortValue,
      index: index >= 0 ? index : tuning.effort.options.length,
    };
  } else if (tuning.thinking?.currentValue === true) {
    level = { id: "thinking", label: "Thinking", index: 1 };
  }
  const contextValue = tuning.contextWindow
    ? getProviderOptionCurrentValue(tuning.contextWindow)
    : undefined;
  const contextWindowLabel =
    tuning.contextWindow && typeof contextValue === "string"
      ? (tuning.contextWindow.options.find((option) => option.id === contextValue)?.label ??
        contextValue)
      : null;
  return {
    level,
    fastMode: tuning.fastMode?.currentValue === true,
    contextWindowLabel,
  };
}

export type ReasoningTone =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "ultracode"
  | "thinking"
  | "off";

const TONE_BY_LEVEL: Readonly<Record<string, ReasoningTone>> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
  ultrathink: "ultra",
  ultracode: "ultracode",
  thinking: "thinking",
  on: "thinking",
  off: "off",
};

/** The colour family for a level id; unknown future levels read as neutral. */
export function reasoningTone(levelId: string | null | undefined): ReasoningTone {
  return (levelId ? TONE_BY_LEVEL[levelId] : undefined) ?? "low";
}
