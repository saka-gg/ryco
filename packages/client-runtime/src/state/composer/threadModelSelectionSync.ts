import type { CommandId, EnvironmentApi, ModelSelection, ThreadId } from "@ryco/contracts";
import { sameModelSelection } from "@ryco/shared/model";

import { normalizeModelSelection } from "./draftPersistence.ts";
import {
  type ComposerDraftImage,
  type ComposerDraftStoreState,
  type ComposerThreadTarget,
  resolveComposerDraftKey,
} from "./draftStore.ts";

/**
 * Keeps a started chat's composer model, effort and speed in step with the selection the node
 * stores on the thread, on every client of that node. A pick is stored on the thread when it is
 * made (after a short pause that folds rapid changes into one write), and a change stored from
 * another client shows in the composer right away. The node applies a stored pick at the next
 * turn: it never restarts or interrupts a running one (`liveThreadModelSelection`).
 *
 * A pick of another provider instance is a handoff, which only a send performs, so it stays in
 * the composer until then. Platform-neutral: each web or native composer gives its view's own
 * `persist` and `show`. One sync per app, so two panes on one chat share one pending write.
 */
export const THREAD_MODEL_SELECTION_PERSIST_DELAY_MS = 300;

export interface ThreadModelSelectionView {
  /** The selection the node stores on the thread; absent while the node has no such chat. */
  readonly serverModelSelection: ModelSelection | null | undefined;
  /** What a send from this composer would carry. */
  readonly composerModelSelection: ModelSelection | null | undefined;
  /** Shows the stored selection in this composer in place of its own pick of that instance. */
  readonly show: (modelSelection: ModelSelection) => void;
  /** Stores a pick on the thread (`thread.meta.update`); rejects when the node refused it. */
  readonly persist: (modelSelection: ModelSelection) => Promise<unknown>;
  /** Tells the user a pick did not land; the composer then shows the stored selection again. */
  readonly reportFailure: (error: unknown) => void;
}

/** Stores a composer's pick on a started chat; rejects when the node refused it. */
export function dispatchThreadModelSelection(
  api: Pick<EnvironmentApi, "orchestration">,
  input: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
    readonly commandId: CommandId;
  },
): Promise<unknown> {
  return api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: input.commandId,
    threadId: input.threadId,
    modelSelection: input.modelSelection,
  });
}

/** The composer's pick to store on the thread, or null when there is nothing to store. */
export function threadModelSelectionToPersist(input: {
  readonly serverModelSelection: ModelSelection | null | undefined;
  readonly composerModelSelection: ModelSelection | null | undefined;
}): ModelSelection | null {
  const stored = input.serverModelSelection;
  const picked = input.composerModelSelection;
  if (!stored || !picked || stored.instanceId !== picked.instanceId) return null;
  return sameModelSelection(stored, picked) ? null : picked;
}

export interface ThreadModelSelectionSync {
  /** The chat as its composer last rendered it, keyed by the scoped thread key. */
  readonly updateView: (threadKey: string, view: ThreadModelSelectionView) => void;
  /** The user picked a model, effort or speed in this chat's composer. */
  readonly committed: (threadKey: string) => void;
  /** The thread's stored selection may have changed. */
  readonly serverChanged: (threadKey: string) => void;
  /** The composer leaves the chat: a pick still waiting out its pause is stored now. */
  readonly release: (threadKey: string) => void;
}

interface ThreadSyncState {
  view: ThreadModelSelectionView | null;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: number;
  /**
   * The stored selection when the pending write began. A change the node reported while the
   * write was pending is held back (this client's own pick is newer) and shown once it settles.
   */
  serverAtPendingStart: ModelSelection | null | undefined;
}

const isPending = (state: ThreadSyncState) => state.timer !== null || state.inFlight > 0;

export function createThreadModelSelectionSync(
  options: { readonly delayMs?: number } = {},
): ThreadModelSelectionSync {
  const delayMs = options.delayMs ?? THREAD_MODEL_SELECTION_PERSIST_DELAY_MS;
  const threads = new Map<string, ThreadSyncState>();

  const stateFor = (threadKey: string): ThreadSyncState => {
    let state = threads.get(threadKey);
    if (!state) {
      state = { view: null, timer: null, inFlight: 0, serverAtPendingStart: undefined };
      threads.set(threadKey, state);
    }
    return state;
  };

  // Forgets a chat no composer shows once nothing is pending for it.
  const forgetIfIdle = (threadKey: string, state: ThreadSyncState) => {
    if (state.view === null && !isPending(state)) threads.delete(threadKey);
  };

  const show = (state: ThreadSyncState) => {
    const view = state.view;
    if (!view?.serverModelSelection || isPending(state)) return;
    view.show(view.serverModelSelection);
  };

  const settle = (threadKey: string, state: ThreadSyncState) => {
    if (isPending(state)) return;
    if (state.view?.serverModelSelection !== state.serverAtPendingStart) show(state);
    forgetIfIdle(threadKey, state);
  };

  const write = (threadKey: string, state: ThreadSyncState) => {
    const view = state.view;
    const modelSelection = view ? threadModelSelectionToPersist(view) : null;
    if (!view || !modelSelection) {
      settle(threadKey, state);
      return;
    }
    state.inFlight += 1;
    // A promise even when `persist` throws, so the pending count always settles.
    Promise.resolve()
      .then(() => view.persist(modelSelection))
      .then(
        () => {
          state.inFlight -= 1;
          settle(threadKey, state);
        },
        (error: unknown) => {
          state.inFlight -= 1;
          view.reportFailure(error);
          // A refused pick goes back to what the thread stores.
          show(state);
          forgetIfIdle(threadKey, state);
        },
      );
  };

  return {
    updateView(threadKey, view) {
      stateFor(threadKey).view = view;
    },
    committed(threadKey) {
      const state = stateFor(threadKey);
      if (!isPending(state)) state.serverAtPendingStart = state.view?.serverModelSelection;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = null;
        write(threadKey, state);
      }, delayMs);
    },
    serverChanged(threadKey) {
      const state = threads.get(threadKey);
      if (state) show(state);
    },
    release(threadKey) {
      const state = threads.get(threadKey);
      if (!state) return;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
        write(threadKey, state);
      }
      state.view = null;
      forgetIfIdle(threadKey, state);
    },
  };
}

/**
 * Shows the selection the node stores on the thread in a composer draft: the draft's own pick of
 * that instance becomes it. A pick of another instance (a pending handoff) and a draft without a
 * pick of this instance (it already reads the thread's) are left as they are.
 */
export function syncComposerDraftWithThreadModelSelection<TImage extends ComposerDraftImage>(
  store: {
    readonly getState: () => ComposerDraftStoreState<TImage>;
    readonly setState: (
      update: (
        state: ComposerDraftStoreState<TImage>,
      ) => ComposerDraftStoreState<TImage> | Partial<ComposerDraftStoreState<TImage>>,
    ) => void;
  },
  target: ComposerThreadTarget,
  modelSelection: ModelSelection,
): void {
  const threadKey = resolveComposerDraftKey(store.getState(), target);
  const normalized = normalizeModelSelection(modelSelection);
  if (!threadKey || !normalized) return;
  store.setState((state) => {
    const existing = state.draftsByThreadKey[threadKey];
    const current = existing?.modelSelectionByProvider[normalized.instanceId];
    if (!existing || current === undefined || sameModelSelection(current, normalized)) {
      return state;
    }
    return {
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [threadKey]: {
          ...existing,
          modelSelectionByProvider: {
            ...existing.modelSelectionByProvider,
            [normalized.instanceId]: normalized,
          },
        },
      },
    };
  });
}
