// FILE: multiModelSendStore.ts
// Purpose: "Compare models" per new draft: the picker's selection and the
//          draft's latest multi-model send, kept beyond the composer's mount.
// Layer: Web UI state, in memory only. The selection and the send's outcomes
//        are lost on reload (see `multiModelSend` in the client runtime).

import type { EnvironmentId } from "@ryco/contracts";
import {
  MODEL_MULTI_SELECT_OFF,
  type ModelMultiSelectState,
  type MultiModelSendTracker,
} from "@ryco/client-runtime/state/composer";
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

/** A draft's latest multi-model send. */
export interface MultiModelSendRecord {
  readonly tracker: MultiModelSendTracker;
  /** Where its threads live. */
  readonly environmentId: EnvironmentId;
  /** Until every target was sent once; the draft sends nothing else meanwhile. */
  readonly sending: boolean;
}

interface MultiModelSendDraftState {
  readonly selection: ModelMultiSelectState;
  readonly send: MultiModelSendRecord | null;
}

interface MultiModelSendStoreState {
  readonly byDraftId: Readonly<Record<string, MultiModelSendDraftState>>;
}

const EMPTY_DRAFT_STATE: MultiModelSendDraftState = {
  selection: MODEL_MULTI_SELECT_OFF,
  send: null,
};

export const useMultiModelSendStore = create<MultiModelSendStoreState>()(() => ({
  byDraftId: {},
}));

function updateDraft(
  draftId: DraftId,
  change: (current: MultiModelSendDraftState) => MultiModelSendDraftState,
): void {
  useMultiModelSendStore.setState((state) => {
    const current = state.byDraftId[draftId] ?? EMPTY_DRAFT_STATE;
    const next = change(current);
    if (next === current) return state;
    const byDraftId = { ...state.byDraftId };
    if (next.selection === MODEL_MULTI_SELECT_OFF && next.send === null) delete byDraftId[draftId];
    else byDraftId[draftId] = next;
    return { byDraftId };
  });
}

export function readMultiModelSelection(draftId: DraftId): ModelMultiSelectState {
  return useMultiModelSendStore.getState().byDraftId[draftId]?.selection ?? MODEL_MULTI_SELECT_OFF;
}

export function setMultiModelSelection(draftId: DraftId, selection: ModelMultiSelectState): void {
  updateDraft(draftId, (current) =>
    current.selection === selection ? current : { ...current, selection },
  );
}

export function readMultiModelSend(draftId: DraftId): MultiModelSendRecord | null {
  return useMultiModelSendStore.getState().byDraftId[draftId]?.send ?? null;
}

export function setMultiModelSend(draftId: DraftId, send: MultiModelSendRecord | null): void {
  updateDraft(draftId, (current) => (current.send === send ? current : { ...current, send }));
}

/** Marks the draft's send `tracker` as sent; a newer send of the draft is left alone. */
export function finishMultiModelSend(draftId: DraftId, tracker: MultiModelSendTracker): void {
  updateDraft(draftId, (current) =>
    current.send?.tracker === tracker && current.send.sending
      ? { ...current, send: { ...current.send, sending: false } }
      : current,
  );
}

export function useMultiModelSelection(draftId: DraftId | null): ModelMultiSelectState {
  return useMultiModelSendStore((state) =>
    draftId
      ? (state.byDraftId[draftId]?.selection ?? MODEL_MULTI_SELECT_OFF)
      : MODEL_MULTI_SELECT_OFF,
  );
}

export function useMultiModelSend(draftId: DraftId | null): MultiModelSendRecord | null {
  return useMultiModelSendStore((state) =>
    draftId ? (state.byDraftId[draftId]?.send ?? null) : null,
  );
}
