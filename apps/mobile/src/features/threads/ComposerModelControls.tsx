import { isTuningDescriptor } from "@ryco/client-runtime/state/composer/modelTuning";
import type { FastModeNotice } from "@ryco/client-runtime/state/session";
import type {
  AgentTokenMode,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@ryco/contracts";
import { getModelSelectionOptionDescriptors } from "@ryco/shared/model";
import type { Ref } from "react";

import type { AnchoredMenuHandle } from "../../components/AnchoredMenu";
import { ComposerMoreControlsMenu, ComposerPolicySelects } from "./ComposerFooterControls";
import { ComposerModelTrigger } from "./ComposerFooterParts";
import { ComposerModelMenu } from "./ComposerModelMenu";
import {
  composerTriggerTraits,
  resolveComposerTuning,
  summarizeComposerTuning,
} from "./composerFooterModel";
import {
  applyModelOption,
  listModelPickerEntries,
  resolveModelPillFastMode,
  type ModelPickerModel,
} from "./modelPickerModel";
import type { SessionPolicyModel } from "./sessionPolicyModel";

// The composer footer's model and policy controls, as a thread shows them: the model pill that
// opens the model picker (provider tabs, search, favorites, the tuning dial), then mode, access
// and tokens — folded into "More composer controls" (⋯) below the shared 620pt breakpoint, the
// desktop's icon selects wider. The chat composer and the schedule editor both render this.

export function ComposerModelControls({
  ref,
  ...props
}: {
  /** The model menu, for `/model`. */
  readonly ref?: Ref<AnchoredMenuHandle>;
  /** Null hides the model pill. */
  readonly modelPicker: ModelPickerModel | null;
  readonly modelSelection: ModelSelection | null;
  readonly onSelectModel: (selection: ModelSelection) => void;
  /** Null hides mode, access and tokens. */
  readonly policy: SessionPolicyModel | null;
  readonly onSelectRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
  /** Absent hides the Tokens control. */
  readonly tokenMode?: AgentTokenMode | undefined;
  readonly onSelectTokenMode?: ((mode: AgentTokenMode) => void) | undefined;
  /** The footer is narrower than the desktop's breakpoint (`isComposerFooterCompact`). */
  readonly compact: boolean;
  readonly disabled: boolean;
  /** The draft, so a prompt-controlled "ultrathink" locks the effort dial as on desktop. */
  readonly prompt?: string;
  /** Claude Code's Fast mode when it differs from the selection's (`deriveClaudeFastModeNotice`). */
  readonly fastModeNotice?: FastModeNotice | null | undefined;
  /** Claude's observed prompt cache, a row inside the model menu. */
  readonly onOpenCacheInfo?: (() => void) | undefined;
  /** The picker's "+" tab: the machine's provider settings. */
  readonly onAddProviders?: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const { modelPicker, modelSelection, policy, compact, disabled } = props;
  // The model pill's readout and the options the tuning dial does not own (agent, variant).
  const tuning =
    modelPicker && modelSelection
      ? resolveComposerTuning({
          model: modelPicker,
          selection: modelSelection,
          prompt: props.prompt ?? "",
        })
      : null;
  const triggerTraits = composerTriggerTraits(summarizeComposerTuning(tuning), compact);
  const fast = modelPicker ? resolveModelPillFastMode(modelPicker, props.fastModeNotice) : null;
  const selectedCapabilities =
    modelPicker && modelSelection
      ? listModelPickerEntries(modelPicker).find(
          (entry) => entry.key === `${modelSelection.instanceId}:${modelSelection.model}`,
        )?.capabilities
      : undefined;
  const traitIds = new Set(
    getModelSelectionOptionDescriptors(modelSelection, selectedCapabilities)
      .filter((descriptor) => !isTuningDescriptor(descriptor))
      .map((descriptor) => descriptor.id),
  );
  const traits = (modelPicker?.options ?? []).filter((option) => traitIds.has(option.id));
  const policyControls = policy
    ? {
        policy,
        tokenMode: props.tokenMode ?? "off",
        onSelectTokenMode: props.tokenMode === undefined ? undefined : props.onSelectTokenMode,
        onSelectRuntimeMode: props.onSelectRuntimeMode,
        onSelectInteractionMode: props.onSelectInteractionMode,
        traits,
        onSelectTrait: (id: string, value: string | boolean) => {
          if (!modelSelection || disabled) return;
          props.onSelectModel(applyModelOption(modelSelection, selectedCapabilities, id, value));
        },
        disabled,
      }
    : null;

  return (
    <>
      {modelPicker && modelSelection ? (
        <ComposerModelMenu
          ref={ref}
          model={modelPicker}
          selection={modelSelection}
          disabled={disabled}
          prompt={props.prompt}
          onSelect={props.onSelectModel}
          onOpenCacheInfo={props.onOpenCacheInfo}
          onAddProviders={props.onAddProviders}
          onClose={props.onClose}
          anchorClassName="min-w-0 shrink"
        >
          {(open) => (
            <ComposerModelTrigger
              providerDriver={modelPicker.pillProviderDriver}
              label={modelPicker.pillLabel}
              traits={triggerTraits}
              fastNotice={
                props.fastModeNotice && fast?.icon && fast.icon !== "bolt.fill"
                  ? { icon: fast.icon, muted: fast.muted }
                  : null
              }
              accessibilityLabel={fast?.accessibilityLabel ?? modelPicker.pillAccessibilityLabel}
              disabled={disabled}
              onPress={open}
            />
          )}
        </ComposerModelMenu>
      ) : null}
      {policyControls ? (
        compact ? (
          <ComposerMoreControlsMenu {...policyControls} onClose={props.onClose} />
        ) : (
          <>
            {traits.length > 0 ? (
              <ComposerMoreControlsMenu {...policyControls} traitsOnly onClose={props.onClose} />
            ) : null}
            <ComposerPolicySelects {...policyControls} onClose={props.onClose} />
          </>
        )
      ) : null}
    </>
  );
}
