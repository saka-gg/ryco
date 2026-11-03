import type { ModelSelection, ScopedThreadRef } from "@ryco/contracts";
import {
  createThreadModelSelectionSync,
  dispatchThreadModelSelection,
  syncComposerDraftWithThreadModelSelection,
} from "@ryco/client-runtime/state/composer";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { useEffect, useLayoutEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import { toastManager } from "../ui/toast";

// One sync for every pane, so two panes on one chat share a single pending write.
const threadModelSelectionSync = createThreadModelSelectionSync();

async function storeThreadModelSelection(
  threadRef: ScopedThreadRef,
  modelSelection: ModelSelection,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) throw new Error("This device is not connected.");
  await dispatchThreadModelSelection(api, {
    threadId: threadRef.threadId,
    modelSelection,
    commandId: newCommandId(),
  });
}

const reportPickFailure = (error: unknown) =>
  toastManager.add({
    type: "error",
    title: "Could not change the model",
    description: error instanceof Error ? error.message : "An unexpected error occurred.",
  });

/** The user picked a model, effort or speed in a started chat's composer. */
export function noteComposerModelSelectionPicked(threadRef: ScopedThreadRef): void {
  threadModelSelectionSync.committed(scopedThreadKey(threadRef));
}

/**
 * Keeps a started chat's composer model, effort and speed in step with the selection the node
 * stores on the thread (`threadModelSelectionSync`), on nodes that store picks when they are
 * made. Elsewhere the composer keeps a pick until it is sent, as before.
 */
export function useLiveThreadModelSelection(input: {
  /** The chat's thread; null for a draft the node does not have yet. */
  readonly threadRef: ScopedThreadRef | null;
  /** Whether the chat's node stores picks on the thread (`liveThreadModelSelection`). */
  readonly enabled: boolean;
  readonly serverModelSelection: ModelSelection | null | undefined;
  readonly composerModelSelection: ModelSelection;
}): void {
  const { threadRef, enabled, serverModelSelection, composerModelSelection } = input;
  const threadKey = enabled && threadRef ? scopedThreadKey(threadRef) : null;

  useLayoutEffect(() => {
    if (threadKey === null || threadRef === null) return;
    threadModelSelectionSync.updateView(threadKey, {
      serverModelSelection,
      composerModelSelection,
      show: (modelSelection) =>
        syncComposerDraftWithThreadModelSelection(useComposerDraftStore, threadRef, modelSelection),
      persist: (modelSelection) => storeThreadModelSelection(threadRef, modelSelection),
      reportFailure: reportPickFailure,
    });
  }, [composerModelSelection, serverModelSelection, threadKey, threadRef]);

  useEffect(() => {
    if (threadKey === null) return;
    // Leaving the chat stores a pick still waiting out its pause instead of dropping it.
    return () => threadModelSelectionSync.release(threadKey);
  }, [threadKey]);

  useEffect(() => {
    // Also on mount: a pick this composer kept while the chat was closed gives way to the
    // node's, which another client may have changed since.
    if (threadKey !== null && serverModelSelection) {
      threadModelSelectionSync.serverChanged(threadKey);
    }
  }, [serverModelSelection, threadKey]);
}
