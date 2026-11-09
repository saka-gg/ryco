import type { SFSymbol } from "expo-symbols";

import type { ModelPickerModel } from "./modelPickerModel";
import type { SessionPolicyModel } from "./sessionPolicyModel";

// What the composer's quiet icon caption shows above the capsule (model logo, effort gauge,
// mode, access, then "Opus 5.5 · High"), and which button ends the capsule. Pure: the .tsx
// only lays it out.

export interface ComposerAccessGlyph {
  readonly icon: SFSymbol;
  /** Full access: the bolt in the caution (amber) color. */
  readonly caution: boolean;
}

/** A lock for every supervised mode, an amber bolt when nothing asks first. */
export function composerAccessGlyph(
  policy: Pick<SessionPolicyModel, "pillTone">,
): ComposerAccessGlyph {
  return policy.pillTone === "caution"
    ? { icon: "bolt.fill", caution: true }
    : { icon: "lock", caution: false };
}

export interface ComposerModeGlyph {
  readonly icon: SFSymbol;
  readonly label: string;
  /** Plan mode reads blue, so a plan-only turn is visible before it is sent. */
  readonly plan: boolean;
}

/** The selected interaction mode's icon, or null when the provider has no modes. */
export function composerModeGlyph(
  policy: Pick<SessionPolicyModel, "mode">,
): ComposerModeGlyph | null {
  const selected = policy.mode?.segments.find((segment) => segment.selected);
  if (!selected) return null;
  return { icon: selected.icon, label: selected.label, plan: selected.value === "plan" };
}

/** "Opus 5.5 · High", or just the model when it declares no effort. */
export function composerCaptionLabel(
  model: Pick<ModelPickerModel, "pillLabel" | "pillReasoningLabel">,
): string {
  return model.pillReasoningLabel
    ? `${model.pillLabel} · ${model.pillReasoningLabel}`
    : model.pillLabel;
}

/** The effort select of the selected model (`reasoningEffort` and friends), if it has one. */
export function composerEffortControl(model: Pick<ModelPickerModel, "options">) {
  return model.options.find((option) => option.kind === "select") ?? null;
}

export type ComposerPrimaryAction = "send" | "stop" | "mic";

/**
 * The capsule's last button: send once there is something to send (while a turn runs that
 * queues it as a follow-up), stop while a turn runs and the field is empty, else the mic. While
 * dictating it stays the (lit) mic: the dictation bar above finishes or cancels.
 */
export function composerPrimaryAction(input: {
  readonly dictating: boolean;
  readonly hasContent: boolean;
  readonly running: boolean;
  readonly canStop: boolean;
}): ComposerPrimaryAction {
  if (input.dictating) return "mic";
  if (input.hasContent) return "send";
  if (input.running && input.canStop) return "stop";
  return "mic";
}
