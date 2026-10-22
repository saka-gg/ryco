// FILE: multiModelSendStore.ts
// Purpose: "Compare models" per new draft: the picker's selection and the
//          draft's multi-model sends, kept beyond the composer's mount.
// Layer: Web UI state, in memory only. The selection and the sends' outcomes
//        are lost on reload (see `multiModelSend` in the client runtime).

import type { EnvironmentId } from "@ryco/contracts";
import {
  MODEL_MULTI_SELECT_OFF,
  isMultiModelSendUnresolved,
  type FileReferenceDraft,
  type ModelMultiSelectState,
  type MultiModelSendTracker,
} from "@ryco/client-runtime/state/composer";
import { create } from "zustand";

import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";

/** What the composer held when a send went out: a model sent again as new gets it back. */
export interface MultiModelSendContent {
  readonly prompt: string;
  readonly images: ComposerImageAttachment[];
  readonly terminalContexts: TerminalContextDraft[];
  readonly fileReferences: FileReferenceDraft[];
}

/** One multi-model send of a draft. */
export interface MultiModelSendRecord {
  readonly tracker: MultiModelSendTracker;
  /** Where its threads live. */
  readonly environmentId: EnvironmentId;
  /** Until every target was sent once; the draft sends nothing else meanwhile. */
  readonly sending: boolean;
  readonly content: MultiModelSendContent;
}

interface MultiModelSendDraftState {
  readonly selection: ModelMultiSelectState;
  /** Newest first: the latest send, then every earlier one still unresolved. */
  readonly sends: ReadonlyArray<MultiModelSendRecord>;
}

interface MultiModelSendStoreState {
  readonly byDraftId: Readonly<Record<string, MultiModelSendDraftState>>;
}

const NO_SENDS: ReadonlyArray<MultiModelSendRecord> = [];
const EMPTY_DRAFT_STATE: MultiModelSendDraftState = {
  selection: MODEL_MULTI_SELECT_OFF,
  sends: NO_SENDS,
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
    if (next.selection === MODEL_MULTI_SELECT_OFF && next.sends.length === 0) {
      delete byDraftId[draftId];
    } else byDraftId[draftId] = next;
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

export function readMultiModelSends(draftId: DraftId): ReadonlyArray<MultiModelSendRecord> {
  return useMultiModelSendStore.getState().byDraftId[draftId]?.sends ?? NO_SENDS;
}

/**
 * Starts tracking a new send of the draft. An earlier send gives way only once
 * it is resolved: one with a model not confirmed, or still going out, stays
 * (its thread id is held nowhere else).
 */
export function addMultiModelSend(draftId: DraftId, send: MultiModelSendRecord): void {
  updateDraft(draftId, (current) => ({
    ...current,
    sends: [
      send,
      ...current.sends.filter(
        (earlier) => earlier.sending || isMultiModelSendUnresolved(earlier.tracker.read()),
      ),
    ],
  }));
}

/** Stops tracking the draft's send `tracker` (the user dismissed it). */
export function removeMultiModelSend(draftId: DraftId, tracker: MultiModelSendTracker): void {
  updateDraft(draftId, (current) =>
    current.sends.some((send) => send.tracker === tracker)
      ? { ...current, sends: current.sends.filter((send) => send.tracker !== tracker) }
      : current,
  );
}

/** Marks the draft's send `tracker` as sent; its other sends are left alone. */
export function finishMultiModelSend(draftId: DraftId, tracker: MultiModelSendTracker): void {
  updateDraft(draftId, (current) =>
    current.sends.some((send) => send.tracker === tracker && send.sending)
      ? {
          ...current,
          sends: current.sends.map((send) =>
            send.tracker === tracker ? { ...send, sending: false } : send,
          ),
        }
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

export function useMultiModelSends(draftId: DraftId | null): ReadonlyArray<MultiModelSendRecord> {
  return useMultiModelSendStore((state) =>
    draftId ? (state.byDraftId[draftId]?.sends ?? NO_SENDS) : NO_SENDS,
  );
}
