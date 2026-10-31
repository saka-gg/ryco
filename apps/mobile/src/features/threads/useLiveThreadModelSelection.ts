import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ModelSelection, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useLayoutEffect } from "react";

import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId } from "../../lib/ids";
import {
  mobileThreadModelSelectionSync,
  mobileThreadModelSelectionView,
} from "./liveThreadModelSelection";

/**
 * Connects the task composer to the live model selection sync (`liveThreadModelSelection.ts`).
 * Returns what the composer calls once the user picked a model, effort or speed.
 */
export function useLiveThreadModelSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly enabled: boolean;
  readonly serverModelSelection: ModelSelection | null | undefined;
  readonly composerModelSelection: ModelSelection | null | undefined;
  readonly updateStaged: (update: (staged: ModelSelection | null) => ModelSelection | null) => void;
  readonly reportFailure: (message: string) => void;
}): () => void {
  const { environmentId, threadId, enabled, serverModelSelection, composerModelSelection } = input;
  const { updateStaged, reportFailure } = input;
  const threadKey = enabled ? scopedThreadKey(scopeThreadRef(environmentId, threadId)) : null;

  useLayoutEffect(() => {
    if (threadKey === null) return;
    mobileThreadModelSelectionSync.updateView(
      threadKey,
      mobileThreadModelSelectionView({
        api: () => ensureEnvironmentApi(environmentId),
        threadId,
        serverModelSelection,
        composerModelSelection,
        updateStaged,
        reportFailure,
        newCommandId,
      }),
    );
  }, [
    composerModelSelection,
    environmentId,
    reportFailure,
    serverModelSelection,
    threadId,
    threadKey,
    updateStaged,
  ]);

  useEffect(() => {
    if (threadKey === null) return;
    return () => mobileThreadModelSelectionSync.release(threadKey);
  }, [threadKey]);

  useEffect(() => {
    if (threadKey !== null && serverModelSelection) {
      mobileThreadModelSelectionSync.serverChanged(threadKey);
    }
  }, [serverModelSelection, threadKey]);

  return useCallback(() => {
    if (threadKey !== null) mobileThreadModelSelectionSync.committed(threadKey);
  }, [threadKey]);
}
