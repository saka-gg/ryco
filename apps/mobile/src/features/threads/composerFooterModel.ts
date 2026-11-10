import { shouldUseCompactComposerFooter } from "@ryco/client-runtime/state/composer/footerLayout";
import {
  reasoningTone,
  resetTuningDescriptors,
  resolveModelTuning,
  summarizeModelTuning,
  withSpeedTier,
  type ModelTuning,
  type ModelTuningSummary,
  type ReasoningTone,
  type SpeedTier,
} from "@ryco/client-runtime/state/composer/modelTuning";
import type {
  AgentTokenMode,
  ModelSelection,
  ProviderOptionDescriptor,
  RuntimeMode,
} from "@ryco/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@ryco/shared/model";

import { listModelPickerEntries, type ModelPickerModel } from "./modelPickerModel";
import { CAUTION_RUNTIME_MODE, tokenModeConfig } from "./sessionPolicyPresentation";

// What the composer card's footer shows, ported from the desktop composer (apps/web
// ComposerFooter, ComposerPrimaryActions, ModelTriggerTraits, ModelTuningDial): the layout rule
// that collapses mode, access and tokens into the "More composer controls" menu below 620pt (one
// shared rule, `shouldUseCompactComposerFooter`), the model pill's readout, the dial's changes and
// the primary action. Pure: the .tsx files only lay it out.

/** The desktop composer's own breakpoint, measured on the card's width. */
export function isComposerFooterCompact(width: number | null): boolean {
  return shouldUseCompactComposerFooter(width);
}

/** The desktop composer's placeholders; the phone has no ⌘↵ steer shortcut to mention. */
export function composerPlaceholder(input: {
  readonly running: boolean;
  readonly override?: string | undefined;
}): string {
  if (input.override) return input.override;
  return input.running ? "Queue a follow-up" : "Ask for follow-up changes or attach images";
}

export type ComposerPrimaryAction = "send" | "queue" | "stop";

/**
 * The card's round button. Desktop keeps Stop up for the whole turn and queues a follow-up with
 * Enter; a phone has no Enter to send with, so typed content turns Stop into the queue button
 * (the same plane glyph) until the field is empty again.
 */
export function composerPrimaryAction(input: {
  readonly hasContent: boolean;
  readonly running: boolean;
  readonly canStop: boolean;
}): ComposerPrimaryAction {
  if (input.running && input.hasContent) return "queue";
  if (input.running && input.canStop) return "stop";
  return "send";
}

/** "Opus 5.5 · High", or just the model when it declares no effort (the context card's row). */
export function composerCaptionLabel(
  model: Pick<ModelPickerModel, "pillLabel" | "pillReasoningLabel">,
): string {
  return model.pillReasoningLabel
    ? `${model.pillLabel} · ${model.pillReasoningLabel}`
    : model.pillLabel;
}

/** The "More composer controls" ellipsis takes the caution tone while Full access is on. */
export function composerControlsCaution(runtimeMode: RuntimeMode): boolean {
  return runtimeMode === CAUTION_RUNTIME_MODE;
}

export function composerTokenModeLabel(tokenMode: AgentTokenMode): string {
  return tokenModeConfig[tokenMode].triggerLabel;
}

/** The selected model's dial state, from its capabilities and the selection's options. */
export function resolveComposerTuning(input: {
  readonly model: Pick<ModelPickerModel, "groups">;
  readonly selection: ModelSelection;
  readonly prompt: string;
}): ModelTuning | null {
  const key = `${input.selection.instanceId}:${input.selection.model}`;
  const caps = listModelPickerEntries(input.model).find((entry) => entry.key === key)?.capabilities;
  if (!caps) return null;
  return resolveModelTuning({ caps, selections: input.selection.options, prompt: input.prompt });
}

export interface ComposerTriggerTraits {
  readonly level: { readonly label: string; readonly tone: ReasoningTone } | null;
  readonly speed: SpeedTier;
  /** Narrow footers drop the context tag; the picker's dial still shows it. */
  readonly contextWindowLabel: string | null;
}

/** The model pill's readout after the name: effort in its tone, the speed bolt, the context tag. */
export function composerTriggerTraits(
  summary: ModelTuningSummary | null,
  compact: boolean,
): ComposerTriggerTraits | null {
  if (!summary) return null;
  const contextWindowLabel = compact ? null : summary.contextWindowLabel;
  if (!summary.level && summary.speed === "standard" && contextWindowLabel === null) return null;
  return {
    level: summary.level
      ? { label: summary.level.label, tone: reasoningTone(summary.level.id) }
      : null,
    speed: summary.speed,
    contextWindowLabel,
  };
}

export function summarizeComposerTuning(tuning: ModelTuning | null): ModelTuningSummary | null {
  return summarizeModelTuning(tuning);
}

export type ComposerTuningChange =
  | { readonly kind: "effort"; readonly value: string }
  | { readonly kind: "thinking"; readonly enabled: boolean }
  | { readonly kind: "speed"; readonly tier: SpeedTier }
  | { readonly kind: "contextWindow"; readonly value: string }
  | { readonly kind: "reset" };

function withValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  id: string | undefined,
  value: string | boolean,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (id === undefined) return descriptors;
  return descriptors.map((descriptor) =>
    descriptor.id === id
      ? ({ ...descriptor, currentValue: value } as ProviderOptionDescriptor)
      : descriptor,
  );
}

/**
 * The selection a dial change produces. Options ride on the selection, so the dial writes the
 * same way the model list does (`thread.meta.update` for a started chat).
 */
export function applyComposerTuningChange(input: {
  readonly model: Pick<ModelPickerModel, "groups">;
  readonly selection: ModelSelection;
  readonly tuning: ModelTuning;
  readonly change: ComposerTuningChange;
}): ModelSelection {
  const { tuning, change } = input;
  const key = `${input.selection.instanceId}:${input.selection.model}`;
  const caps = listModelPickerEntries(input.model).find((entry) => entry.key === key)?.capabilities;
  let next: ReadonlyArray<ProviderOptionDescriptor>;
  switch (change.kind) {
    case "effort":
      if (!tuning.effort?.options.some((option) => option.id === change.value))
        return input.selection;
      next = withValue(tuning.descriptors, tuning.effort.id, change.value);
      break;
    case "thinking":
      next = withValue(tuning.descriptors, tuning.thinking?.id, change.enabled);
      break;
    case "speed":
      next = withSpeedTier(tuning.descriptors, change.tier);
      break;
    case "contextWindow":
      if (!tuning.contextWindow?.options.some((option) => option.id === change.value))
        return input.selection;
      next = withValue(tuning.descriptors, tuning.contextWindow.id, change.value);
      break;
    case "reset":
      if (!caps) return input.selection;
      next = resetTuningDescriptors({ caps, descriptors: tuning.descriptors });
      break;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(next);
  if (options) return { ...input.selection, options };
  const { options: _dropped, ...rest } = input.selection;
  return rest;
}

/** Theme variable of a reasoning tone (`--color-reasoning-*`, the desktop's `--reasoning-tone-*`). */
export function reasoningToneColorVar(tone: ReasoningTone): `--color-reasoning-${ReasoningTone}` {
  return `--color-reasoning-${tone}`;
}

/** Fast and Ultrafast take their own tones; standard speed has none. */
export function speedToneColorVar(
  tier: SpeedTier,
): "--color-fast-mode" | "--color-ultrafast-mode" | null {
  return tier === "fast"
    ? "--color-fast-mode"
    : tier === "ultrafast"
      ? "--color-ultrafast-mode"
      : null;
}
