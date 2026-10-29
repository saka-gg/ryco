import type {
  ProviderDriverKind,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@ryco/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@ryco/shared/model";

import { getProviderModelCapabilities } from "./providerModels.ts";

export interface ModelEsque {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly isCustom?: boolean;
  readonly isUnavailable?: boolean;
  readonly isLegacy?: boolean;
}

export interface ComposerProviderStateInput {
  readonly provider: ProviderDriverKind;
  readonly model: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly prompt: string;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}

export interface ComposerProviderState {
  readonly provider: ProviderDriverKind;
  readonly promptEffort: string | null;
  readonly modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly composerFrameClassName?: string;
  readonly composerSurfaceClassName?: string;
  readonly modelPickerIconClassName?: string;
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const caps = getProviderModelCapabilities(input.models, input.model, input.provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: input.modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(input.prompt);

  return {
    provider: input.provider,
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
