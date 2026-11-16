import type { AgentTokenMode, ProviderInteractionMode, RuntimeMode } from "@ryco/contracts";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { boundedDisabledReason } from "../mobile/MobileListRow";
import { MobileSegmentedControl } from "../mobile/MobileSegmentedControl";
import {
  MobileSheet,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../mobile/MobileSheet";
import { Button } from "../ui/button";
import { tokenModeOptions, tokenModePresentation } from "../../tokenModePresentation";
import { ASK_MODE_UNSUPPORTED_DESCRIPTION } from "./CompactComposerControlsMenu";
import {
  CAUTION_RUNTIME_MODE,
  CAUTION_RUNTIME_MODE_CLASS_NAME,
  interactionModeConfig,
  interactionModeOptions,
  runtimeModeConfig,
  runtimeModeOptions,
} from "./sessionPolicyPresentation";

/**
 * The phone session-policy sheet: interaction mode, runtime mode, and token
 * budget, on their own control rather than beneath the model list.
 *
 * The separation from the model sheet is deliberate. `full-access` is a
 * security-relevant selection carrying a warning treatment, and burying it
 * under a scrolling list of model names is the wrong affordance. Here it is one
 * of three discrete segments, each its own activation target, so it can only be
 * chosen on purpose — a swipe across the control commits nothing.
 *
 * Policy semantics are unchanged: this is presentation plus mutation gating.
 */

export interface PhoneSessionPolicyProps {
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
  readonly showInteractionModeToggle: boolean;
  readonly askModeSupported: boolean;
  /** Renders the disabled presentation and blocks every change. */
  readonly disabled?: boolean | undefined;
  /** Bounded, operator-facing reason. Never a raw error or payload. */
  readonly disabledReason?: string | undefined;
  readonly onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
  readonly onTokenModeChange: (mode: AgentTokenMode) => void;
}

export const PhoneSessionPolicySheet = memo(function PhoneSessionPolicySheet(
  props: PhoneSessionPolicyProps & {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  },
) {
  const disabled = props.disabled ?? false;
  const reason = disabled && props.disabledReason ? props.disabledReason : undefined;

  return (
    <MobileSheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      label="Session policy"
      detent="medium"
    >
      <MobileSheetHeader>
        <MobileSheetTitle>Session policy</MobileSheetTitle>
      </MobileSheetHeader>
      <MobileSheetPanel>
        <div className="flex flex-col gap-4 pb-2" data-slot="phone-session-policy">
          {props.showInteractionModeToggle ? (
            <MobileSegmentedControl
              label="Mode"
              value={props.interactionMode}
              disabled={disabled}
              {...(reason ? { disabledReason: reason } : {})}
              options={interactionModeOptions.map((mode) => {
                const option = interactionModeConfig[mode];
                const unsupported = mode === "ask" && !props.askModeSupported;
                return unsupported
                  ? {
                      id: mode,
                      label: option.label,
                      description: ASK_MODE_UNSUPPORTED_DESCRIPTION,
                      disabled: true,
                      disabledReason: ASK_MODE_UNSUPPORTED_DESCRIPTION,
                    }
                  : { id: mode, label: option.label, description: option.description };
              })}
              onChange={(mode) => props.onInteractionModeChange(mode as ProviderInteractionMode)}
            />
          ) : null}

          <MobileSegmentedControl
            label="Access"
            value={props.runtimeMode}
            disabled={disabled}
            {...(reason ? { disabledReason: reason } : {})}
            options={runtimeModeOptions.map((mode) =>
              mode === CAUTION_RUNTIME_MODE
                ? {
                    id: mode,
                    label: runtimeModeConfig[mode].label,
                    description: runtimeModeConfig[mode].description,
                    tone: "caution" as const,
                  }
                : {
                    id: mode,
                    label: runtimeModeConfig[mode].label,
                    description: runtimeModeConfig[mode].description,
                  },
            )}
            onChange={(mode) => props.onRuntimeModeChange(mode as RuntimeMode)}
          />

          <MobileSegmentedControl
            label="Tokens"
            value={props.tokenMode}
            disabled={disabled}
            {...(reason ? { disabledReason: reason } : {})}
            options={tokenModeOptions.map((mode) => ({
              id: mode,
              label: tokenModePresentation[mode].label,
              description: tokenModePresentation[mode].description,
            }))}
            onChange={(mode) => props.onTokenModeChange(mode as AgentTokenMode)}
          />
        </div>
      </MobileSheetPanel>
    </MobileSheet>
  );
});

/**
 * The composer's phone session-policy control: a trigger reporting the current
 * access mode, plus the sheet it opens. The trigger keeps the same warning
 * treatment the desktop runtime-mode select gives full access.
 */
export const PhoneSessionPolicyControl = memo(function PhoneSessionPolicyControl(
  props: PhoneSessionPolicyProps,
) {
  const [open, setOpen] = useState(false);
  const disabled = props.disabled ?? false;
  const runtimeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeIcon = runtimeOption.icon;
  const interactionOption = interactionModeConfig[props.interactionMode];
  const reason =
    disabled && props.disabledReason ? boundedDisabledReason(props.disabledReason) : null;

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        type="button"
        data-chat-session-policy-trigger="true"
        className={cn(
          // A real 44px box, like the model pill beside it. Relying on
          // `Button`'s `::after` slop would make this control's target depend
          // on a SIBLING keeping the row 44px tall.
          "min-h-11 shrink-0 gap-1 whitespace-nowrap px-1.5 font-medium text-muted-foreground/80 hover:text-foreground/80",
          props.runtimeMode === CAUTION_RUNTIME_MODE && CAUTION_RUNTIME_MODE_CLASS_NAME,
        )}
        disabled={disabled}
        aria-label={`Session policy: ${interactionOption.triggerLabel}, ${runtimeOption.triggerLabel}`}
        title={reason ?? runtimeOption.description}
        onClick={() => setOpen(true)}
      >
        <RuntimeIcon aria-hidden className="size-4" />
        <span className="truncate">{runtimeOption.triggerLabel}</span>
      </Button>
      <PhoneSessionPolicySheet {...props} open={open} onOpenChange={setOpen} />
    </>
  );
});
