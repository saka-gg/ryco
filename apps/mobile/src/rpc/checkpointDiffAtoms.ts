// §6 checkpoint-diff cache: the shared bounded store from client-runtime over
// the app atom registry, with requests routed through ensureEnvironmentApi. The
// unwatched set is bounded tighter than on web: a phone holds less, and the OS
// may kill the app over memory it keeps.
import type { EnvironmentId } from "@ryco/contracts";
import { createCheckpointDiffStore } from "@ryco/client-runtime/rpc";

import { cachedPayloadBytes } from "../persistence/cacheSize";
import { ensureEnvironmentApi } from "../connection/environmentApi";

export {
  checkpointDiffCacheKey,
  type CheckpointDiffInput,
  type CheckpointDiffState,
} from "@ryco/client-runtime/rpc";

/** Unwatched diffs kept for a quick reopen; watched diffs are never evicted. */
export const MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES = 4;
/** Retained patch characters (UTF-16, so about twice as many bytes) across unwatched diffs. */
export const MAX_INACTIVE_CHECKPOINT_DIFF_CHARS = 4 * 1024 * 1024;

const store = createCheckpointDiffStore({
  resolveOrchestrationApi: (environmentId) => ensureEnvironmentApi(environmentId).orchestration,
  maxInactiveEntries: MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES,
  maxInactiveChars: MAX_INACTIVE_CHECKPOINT_DIFF_CHARS,
});

export const {
  checkpointDiffStateAtom,
  watchCheckpointDiff,
  evictCheckpointDiffsForThread,
  invalidateCheckpointDiff,
  invalidateAllCheckpointDiffs,
  clearCheckpointDiffState,
} = store;

export const resetCheckpointDiffStateForTests = clearCheckpointDiffState;

/** Estimated bytes of one device's unwatched cached diffs (Settings cache usage). */
export function checkpointDiffCacheBytes(environmentId: EnvironmentId): number {
  let bytes = 0;
  for (const result of store.readUnwatchedCheckpointDiffResults(environmentId)) {
    bytes += cachedPayloadBytes(result);
  }
  return bytes;
}

/** Drops one device's unwatched cached diffs; a diff on screen stays. */
export function clearCheckpointDiffCacheForEnvironment(environmentId: EnvironmentId): void {
  store.clearUnwatchedCheckpointDiffsForEnvironment(environmentId);
}
