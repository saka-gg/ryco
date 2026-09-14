import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
} from "@ryco/contracts";
import { UnifiedSettings } from "@ryco/contracts/settings";
import {
  DraftId,
  EMPTY_COMPOSER_DRAFT_MODEL_STATE,
  EMPTY_THREAD_DRAFT,
  deriveEffectiveComposerModelState,
  getComposerDraftState,
  useComposerDraftStore,
  type ComposerDraftModelState,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  type DraftSessionState,
  type DraftThreadState,
  type EffectiveComposerModelState,
} from "./composerDraftStore";

/**
 * Read-only composer draft selectors.
 *
 * These hooks and selector helpers are the read surface used by route views
 * and the composer UI. They never mutate store state; all writes live on the
 * store actions in `composerDraftStore.ts`.
 */

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

export function useEffectiveComposerModelState(input: {
  threadRef?: ComposerThreadTarget;
  draftId?: DraftId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * When supplied, the draft's saved selection for this instance takes
   * precedence over the driver-kind bucket — so a custom `codex_personal`
   * instance reads its own model, not the default Codex's.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerDraftModelState(input.threadRef ?? input.draftId ?? DraftId.make(""));

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        selectedInstanceId: input.selectedInstanceId,
        threadModelSelection: input.threadModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.selectedInstanceId,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

/**
 * Looks up the mutable draft session for a `DraftId`, or `null` when there is
 * no draft session tracked under that id.
 */
export function useDraftSession(draftId: DraftId): DraftSessionState | null {
  return useComposerDraftStore((store) => store.getDraftSession(draftId));
}

/**
 * Resolves the draft session backing a server thread ref, or `null`.
 */
export function useDraftThreadByRef(
  threadRef: ScopedThreadRef | null | undefined,
): DraftThreadState | null {
  return useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
}

/**
 * `true` when a draft session exists for the given server thread ref.
 */
export function useDraftThreadExistsByRef(threadRef: ScopedThreadRef | null | undefined): boolean {
  return useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
}

/**
 * `true` when the environment has at least one tracked draft session.
 */
export function useEnvironmentHasDraftThreads(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  return useComposerDraftStore((store) =>
    environmentId ? store.hasDraftThreadsInEnvironment(environmentId) : false,
  );
}
