import type { ProviderInteractionMode, RuntimeMode } from "@ryco/contracts";
import type { SFSymbol } from "expo-symbols";

import {
  interactionModeConfig,
  interactionModeOptions,
  runtimeModeConfig,
  runtimeModeOptions,
  type SessionPolicyTone,
} from "./sessionPolicyPresentation";

// Every decision the session-policy rail and sheet make, as a pure function.
// `apps/mobile` cannot mount a React Native component in a test, so the .tsx
// files below this are layout only (program status §1.1).

export interface SessionPolicySegment<Value extends string> {
  readonly value: Value;
  /** Full name. Used for accessibility and anywhere width is not a constraint. */
  readonly label: string;
  /**
   * Compact name for the segment itself. Three segments share a phone's width,
   * and "Auto-accept edits" truncates to "Auto-acc…" there — which reads as a
   * rendering bug rather than a setting. This is what the segment shows; the
   * full label still reaches screen readers.
   */
  readonly shortLabel: string;
  readonly description: string;
  readonly icon: SFSymbol;
  readonly tone: SessionPolicyTone;
  readonly selected: boolean;
  readonly disabled: boolean;
  /** Why the segment is unavailable. Rendered next to it — never swallowed. */
  readonly disabledReason: string | null;
}

export interface SessionPolicyGroup<Value extends string> {
  readonly key: "access" | "mode";
  readonly label: string;
  readonly segments: ReadonlyArray<SessionPolicySegment<Value>>;
}

export interface SessionPolicyModel {
  /** Collapsed rail pill: the short name of the current access mode. */
  readonly pillLabel: string;
  readonly pillIcon: SFSymbol;
  readonly pillTone: SessionPolicyTone;
  readonly pillAccessibilityLabel: string;
  readonly access: SessionPolicyGroup<RuntimeMode>;
  /**
   * Null when the provider declares it does not support interaction modes, in
   * which case the whole group is hidden rather than shown empty or disabled.
   */
  readonly mode: SessionPolicyGroup<ProviderInteractionMode> | null;
  /** True when nothing in the sheet can be changed right now. */
  readonly readOnly: boolean;
  readonly readOnlyReason: string | null;
}

export interface SessionPolicyInput {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * From `getProviderInteractionModeToggle`. Defaults TRUE upstream — the group
   * hides only when a provider explicitly opts out.
   */
  readonly interactionModeSupported: boolean;
  /**
   * From `getProviderSupportsAskMode`. Defaults FALSE upstream — `ask` is
   * disabled unless a provider explicitly declares it.
   */
  readonly askModeSupported: boolean;
  /**
   * From `getAutoRuntimeModeUnavailableReason`: set when the selected instance
   * reports that its model cannot run Auto. The server downgrades an Auto
   * session on its own; this keeps the picker from offering it.
   */
  readonly autoModeUnavailableReason?: string | null;
  /** Set while the environment cannot accept mutations (offline, viewer role…). */
  readonly mutationBlockedReason?: string | null;
}

const ASK_UNSUPPORTED_REASON = "This provider does not support Ask mode.";

export function buildSessionPolicyModel(input: SessionPolicyInput): SessionPolicyModel {
  const blocked = input.mutationBlockedReason?.trim() || null;
  const current = runtimeModeConfig[input.runtimeMode];

  const access: SessionPolicyGroup<RuntimeMode> = {
    key: "access",
    label: "Access",
    segments: runtimeModeOptions.map((value) => {
      const presentation = runtimeModeConfig[value];
      // Like an unsupported `ask`, a refused `auto` stays disabled even when
      // mutation is allowed.
      const autoUnavailable = (value === "auto" && input.autoModeUnavailableReason?.trim()) || null;
      return {
        value,
        label: presentation.label,
        shortLabel: presentation.triggerLabel,
        description: presentation.description,
        icon: presentation.icon,
        tone: presentation.tone,
        selected: value === input.runtimeMode,
        disabled: blocked !== null || autoUnavailable !== null,
        disabledReason: blocked ?? autoUnavailable,
      };
    }),
  };

  const mode: SessionPolicyGroup<ProviderInteractionMode> | null = input.interactionModeSupported
    ? {
        key: "mode",
        label: "Mode",
        segments: interactionModeOptions.map((value) => {
          const presentation = interactionModeConfig[value];
          // `ask` carries its own gate, and it is the narrower one: a blocked
          // environment disables everything, but an unsupported `ask` stays
          // disabled even when mutation is allowed.
          const askUnsupported = value === "ask" && !input.askModeSupported;
          return {
            value,
            label: presentation.label,
            shortLabel: presentation.triggerLabel,
            description: presentation.description,
            icon: presentation.icon,
            tone: presentation.tone,
            selected: value === input.interactionMode,
            disabled: blocked !== null || askUnsupported,
            disabledReason: blocked ?? (askUnsupported ? ASK_UNSUPPORTED_REASON : null),
          };
        }),
      }
    : null;

  return {
    pillLabel: current.triggerLabel,
    pillIcon: current.icon,
    pillTone: current.tone,
    pillAccessibilityLabel: `Session policy. Access: ${current.label}.${
      mode ? ` Mode: ${interactionModeConfig[input.interactionMode].label}.` : ""
    }`,
    access,
    mode,
    readOnly: blocked !== null,
    readOnlyReason: blocked,
  };
}

/**
 * What a selection should become when the user taps a segment. Returns null
 * when the tap must be ignored, so the caller never has to re-derive the
 * disabled rules it already asked this module about.
 */
export function resolveSessionPolicySelection<Value extends string>(
  group: SessionPolicyGroup<Value>,
  value: Value,
): Value | null {
  const segment = group.segments.find((candidate) => candidate.value === value);
  if (!segment || segment.disabled || segment.selected) return null;
  return segment.value;
}
