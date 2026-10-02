import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@ryco/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@ryco/shared/model";
import { memo } from "react";

import { getProviderModelCapabilities } from "../../providerModels";
import { boundedDisabledReason } from "~/lib/boundedReason";

import { AgentChip } from "./AgentChip";
import { GenericSelectChip } from "./GenericSelectChip";
import { isTuningDescriptor } from "./modelTuning.logic";
import {
  useProviderOptionsUpdater,
  type ProviderOptions,
  type ProviderOptionsPersistence,
} from "./useProviderOptionsUpdater";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export type TraitsChipsProps = {
  hideAgent?: boolean;
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  /**
   * Renders the disabled presentation and blocks every option change. The
   * chips sit beside the model pill and the session-policy control in the
   * composer, so they gate on the same read-only mutation capability those do
   * rather than staying live next to two disabled controls.
   */
  disabled?: boolean;
  /** Bounded, operator-facing reason shown when `disabled`. */
  disabledReason?: string;
} & ProviderOptionsPersistence;

/**
 * Composer chips for the provider options the model picker's tuning dial does
 * not own: the agent and any provider-specific select (e.g. OpenCode's
 * "variant"). Effort, fast mode, context window and thinking live in the dial.
 */
export const TraitsChips = memo(function TraitsChips(props: TraitsChipsProps) {
  const disabled = props.disabled ?? false;
  const updateModelOptions = useProviderOptionsUpdater({ ...props, disabled });

  const caps = getProviderModelCapabilities(props.models, props.model, props.provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: props.modelOptions });
  const selects = descriptors.filter(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.type === "select" &&
      !isTuningDescriptor(descriptor) &&
      !(props.hideAgent && descriptor.id === "agent"),
  );
  if (selects.length === 0) return null;

  const onChangeDescriptors = (next: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(next));
  };
  const reason =
    disabled && props.disabledReason ? boundedDisabledReason(props.disabledReason) : null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {selects.map((descriptor) =>
        descriptor.id === "agent" ? (
          <AgentChip
            key={descriptor.id}
            descriptor={descriptor}
            descriptors={descriptors}
            onChangeDescriptors={onChangeDescriptors}
            disabled={disabled}
          />
        ) : (
          <GenericSelectChip
            key={descriptor.id}
            descriptor={descriptor}
            descriptors={descriptors}
            onChangeDescriptors={onChangeDescriptors}
            disabled={disabled}
          />
        ),
      )}
      {reason ? (
        <span className="text-muted-foreground/80 text-xs" data-slot="traits-disabled-reason">
          {reason}
        </span>
      ) : null}
    </div>
  );
});
