import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@ryco/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@ryco/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { ComposerModelTuning } from "./ModelTuningDial";
import {
  resolveModelTuning,
  summarizeModelTuning,
  type ModelTuningSummary,
} from "./modelTuning.logic";
import { shouldRenderTraitsControls, TraitsMenuContent } from "./TraitsPicker";
import { TraitsChips } from "./TraitsChips";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  hideAgent?: boolean;
  /** Leave out what the model picker's tuning dial owns (desktop menus beside it). */
  omitTuning?: boolean;
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  /**
   * Renders both traits presentations disabled and blocks every option change.
   * Threaded from the composer's read-only mutation capability so the traits
   * gate matches the model pill and the session-policy control beside them.
   */
  disabled?: boolean;
  /** Bounded, operator-facing reason. Never a raw error or payload. */
  disabledReason?: string | null;
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
    disabled,
    disabledReason,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions,
      prompt,
      hideAgent: input.hideAgent ?? false,
      omitTuning: input.omitTuning ?? false,
    })
  ) {
    return null;
  }
  return (
    <TraitsMenuContent
      hideAgent={input.hideAgent ?? false}
      omitTuning={input.omitTuning ?? false}
      disabled={disabled ?? false}
      {...(disabledReason ? { disabledReason } : {})}
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      prompt={prompt}
      onPromptChange={onPromptChange}
    />
  );
}

/**
 * Composer chips for the options the tuning dial does not own (agent,
 * provider-specific selects). Effort, fast mode, context and thinking are in
 * the model picker.
 */
export function renderProviderTraitsChips(input: TraitsRenderInput): ReactNode {
  const { provider, instanceId, threadRef, draftId, model, models, modelOptions } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions,
      prompt: input.prompt,
      hideAgent: input.hideAgent ?? false,
      omitTuning: true,
    })
  ) {
    return null;
  }
  return (
    <TraitsChips
      hideAgent={input.hideAgent ?? false}
      disabled={input.disabled ?? false}
      {...(input.disabledReason ? { disabledReason: input.disabledReason } : {})}
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
    />
  );
}

/** The model picker's tuning dial for the composer's active model, or null. */
export function renderProviderModelTuning(input: TraitsRenderInput): ReactNode {
  const { provider, instanceId, threadRef, draftId, model, models, modelOptions } = input;
  if (threadRef === undefined && draftId === undefined) return null;
  const caps = getProviderModelCapabilities(models, model, provider);
  if (!resolveModelTuning({ caps, selections: modelOptions, prompt: input.prompt })) return null;
  return (
    <ComposerModelTuning
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      model={model}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      modelOptions={modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
      disabled={input.disabled ?? false}
    />
  );
}

/** What the composer's model pill shows next to the model name. */
export function getProviderModelTuningSummary(input: {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  prompt: string;
}): ModelTuningSummary | null {
  const caps = getProviderModelCapabilities(input.models, input.model, input.provider);
  return summarizeModelTuning(
    resolveModelTuning({ caps, selections: input.modelOptions, prompt: input.prompt }),
  );
}
