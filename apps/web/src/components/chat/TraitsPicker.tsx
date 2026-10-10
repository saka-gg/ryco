import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@ryco/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@ryco/shared/model";
import { memo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  availableSpeedTiers,
  currentSpeedTier,
  isSpeedDescriptor,
  isTuningDescriptor,
  reasoningTone,
  SPEED_TIER_LABELS,
  withSpeedTier,
} from "./modelTuning.logic";
import { applyDescriptorSelection, replaceDescriptorCurrentValue } from "./traitsMenuLogic";
import {
  useProviderOptionsUpdater,
  type ProviderOptions,
  type ProviderOptionsPersistence,
} from "./useProviderOptionsUpdater";
import { boundedDisabledReason } from "~/lib/boundedReason";
import { cn } from "~/lib/utils";

type TraitsPersistence = ProviderOptionsPersistence;

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  hideAgent: boolean,
  omitTuning: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: modelOptions,
  });
  // `omitTuning` hides what the model picker's dial owns, so a menu shown
  // beside the dial carries only the remaining options (agent, variants).
  const visible = (descriptor: ProviderOptionDescriptor) =>
    !(omitTuning && isTuningDescriptor(descriptor));
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" &&
      visible(descriptor) &&
      !(hideAgent && descriptor.id === "agent"),
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean" && visible(descriptor),
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const fastModeEnabled =
    typeof fastModeDescriptor?.currentValue === "boolean" ? fastModeDescriptor.currentValue : false;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    fastModeEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  hideAgent?: boolean;
  omitTuning?: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
    input.hideAgent ?? false,
    input.omitTuning ?? false,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: showEffort || showThinking || showFastMode || showContextWindow || showAgent,
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  hideAgent?: boolean;
  omitTuning?: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  hideAgent?: boolean;
  /** Leave out the options the model picker's tuning dial owns. */
  omitTuning?: boolean;
  /**
   * Renders the disabled presentation and blocks every option change. The
   * traits-side equivalent of `ProviderModelPicker`'s `disabled`: call sites
   * pass the read-only mutation capability's negation rather than sensing
   * connectivity themselves.
   */
  disabled?: boolean;
  /**
   * Bounded, operator-facing reason shown when `disabled`. Never a raw error,
   * identifier, ticket, or payload.
   */
  disabledReason?: string;
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  hideAgent = false,
  omitTuning = false,
  disabled = false,
  disabledReason,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const updateModelOptions = useProviderOptionsUpdater({
    ...persistence,
    provider,
    instanceId,
    model,
    disabled,
  });
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    hideAgent,
    omitTuning,
  });
  const boundedReason = disabled && disabledReason ? boundedDisabledReason(disabledReason) : null;
  // Fast and Ultrafast are two options but one exclusive choice: offered
  // together, they read as a single Speed group.
  const speedTiers = availableSpeedTiers(booleanDescriptors);
  const groupsSpeed = speedTiers.length > 2;
  const plainBooleanDescriptors = groupsSpeed
    ? booleanDescriptors.filter((descriptor) => !isSpeedDescriptor(descriptor))
    : booleanDescriptors;
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    // Fail closed: the items are already disabled, so this only matters if a
    // change ever reaches here another way.
    if (disabled) return;
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (disabled) return;
    applyDescriptorSelection({
      descriptors,
      descriptor,
      value,
      prompt,
      primarySelectDescriptorId: primarySelectDescriptor?.id,
      ultrathinkInBodyText,
      ultrathinkPromptControlled,
      onChangeDescriptors: updateDescriptors,
      onPromptChange,
    });
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {boundedReason ? (
        <div
          className="px-2 pt-1.5 pb-1 text-muted-foreground/80 text-xs"
          data-slot="traits-disabled-reason"
        >
          {boundedReason}
        </div>
      ) : null}
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                option.
              </div>
            ) : null}
            <MenuRadioGroup
              value={
                ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
                  ? "ultrathink"
                  : (getDescriptorStringValue(descriptor) ?? "")
              }
              onValueChange={(value) => handleSelectChange(descriptor, value)}
            >
              {descriptor.options.map((option) => (
                <MenuRadioItem
                  key={option.id}
                  value={option.id}
                  className={
                    descriptor.id === primarySelectDescriptor?.id
                      ? "text-(--reasoning-tone-text)"
                      : undefined
                  }
                  data-reasoning-level={
                    descriptor.id === primarySelectDescriptor?.id ? option.id : undefined
                  }
                  data-reasoning-tone={
                    descriptor.id === primarySelectDescriptor?.id
                      ? reasoningTone(option.id)
                      : undefined
                  }
                  disabled={
                    disabled ||
                    (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id)
                  }
                >
                  {option.label}
                  {option.isDefault ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {plainBooleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <MenuRadioGroup
              value={descriptor.currentValue === true ? "on" : "off"}
              onValueChange={(value) => {
                updateDescriptors(
                  replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
                );
              }}
            >
              <MenuRadioItem value="on" disabled={disabled}>
                On
              </MenuRadioItem>
              <MenuRadioItem value="off" disabled={disabled}>
                Off
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {groupsSpeed ? (
        <div>
          {selectDescriptors.length > 0 || plainBooleanDescriptors.length > 0 ? (
            <MenuDivider />
          ) : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Speed</div>
            <MenuRadioGroup
              value={currentSpeedTier(descriptors)}
              onValueChange={(value) => {
                const tier = speedTiers.find((candidate) => candidate === value);
                if (tier) updateDescriptors(withSpeedTier(descriptors, tier));
              }}
            >
              {speedTiers.map((tier) => (
                <MenuRadioItem key={tier} value={tier} disabled={disabled}>
                  {SPEED_TIER_LABELS[tier]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ) : null}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  hideAgent = false,
  disabled = false,
  disabledReason,
  triggerSize,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
      hideAgent,
    });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
      hideAgent,
    })
  ) {
    return null;
  }

  const speedLabel = (() => {
    const tier = currentSpeedTier(descriptors);
    return tier === "standard" ? "Normal" : SPEED_TIER_LABELS[tier];
  })();
  const firstSpeedDescriptor = descriptors.find(isSpeedDescriptor);
  const triggerLabel =
    descriptors
      .map((descriptor) => {
        if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
          return "Ultrathink";
        }
        if (descriptor.type === "boolean") {
          if (isSpeedDescriptor(descriptor)) {
            return descriptor === firstSpeedDescriptor ? speedLabel : null;
          }
          return `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`;
        }
        return getProviderOptionCurrentLabel(descriptor);
      })
      .filter((label): label is string => typeof label === "string" && label.length > 0)
      .join(" · ") || "";

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size={triggerSize ?? "sm"}
            variant={triggerVariant ?? "ghost"}
            disabled={disabled}
            {...(disabled && disabledReason
              ? { title: boundedDisabledReason(disabledReason) }
              : {})}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-1.5 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-44 sm:px-2 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-1.5 text-muted-foreground/70 hover:text-foreground/80 sm:px-2",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          hideAgent={hideAgent}
          disabled={disabled}
          {...(disabledReason ? { disabledReason } : {})}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
