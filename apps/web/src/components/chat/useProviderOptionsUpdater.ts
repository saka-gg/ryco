import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ScopedThreadRef,
} from "@ryco/contracts";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";

export type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * Where provider option changes land: the composer draft (keyed by thread or
 * draft id) or a caller-owned callback (settings forms).
 */
export type ProviderOptionsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      draftId?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

/**
 * One write path for every provider-option control (composer chips, traits
 * menu, model tuning dial). Fails closed while `disabled`.
 */
export function useProviderOptionsUpdater(
  input: {
    provider: ProviderDriverKind;
    instanceId?: ProviderInstanceId | undefined;
    model: string | null | undefined;
    disabled?: boolean | undefined;
  } & ProviderOptionsPersistence,
): (nextOptions: ProviderOptions | undefined) => void {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const { provider, instanceId, model, disabled, threadRef, draftId, onModelOptionsChange } = input;
  return useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if (disabled) return;
      if (onModelOptionsChange) {
        onModelOptionsChange(nextOptions);
        return;
      }
      const threadTarget = threadRef ?? draftId;
      if (!threadTarget) return;
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [
      disabled,
      draftId,
      instanceId,
      model,
      onModelOptionsChange,
      provider,
      setProviderModelOptions,
      threadRef,
    ],
  );
}
