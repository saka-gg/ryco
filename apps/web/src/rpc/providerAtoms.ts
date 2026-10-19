// Checkpoint-diff cache: the shared bounded store from client-runtime over the
// app atom registry, with requests routed through ensureEnvironmentApi.
import type { EnvironmentId } from "@ryco/contracts";
import {
  createCheckpointDiffStore,
  DISABLED_CHECKPOINT_DIFF_STATE,
} from "@ryco/client-runtime/rpc";
import { Atom } from "effect/reactivity";

import { ensureEnvironmentApi } from "../environmentApi";

export {
  checkpointDiffCacheKey,
  checkpointDiffRetryDelay,
  decodeCheckpointDiffRequest,
  DISABLED_CHECKPOINT_DIFF_STATE,
  isCheckpointDiffEnabled,
  isCheckpointTemporarilyUnavailable,
  normalizeCheckpointErrorMessage,
  shouldRetryCheckpointDiff,
  type CheckpointDiffInput,
  type CheckpointDiffState,
} from "@ryco/client-runtime/rpc";

/**
 * Unwatched entries stay cached so re-opening a recent diff is instant, but
 * patches can reach 10 MB each, so the inactive set is bounded by count and by
 * retained patch characters. Watched entries are never evicted.
 */
export const MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES = 8;
export const MAX_INACTIVE_CHECKPOINT_DIFF_CHARS = 16 * 1024 * 1024;

export const DISABLED_CHECKPOINT_DIFF_ATOM = Atom.make(DISABLED_CHECKPOINT_DIFF_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("checkpoint-diff:disabled"),
);

const store = createCheckpointDiffStore({
  resolveOrchestrationApi: (environmentId) => ensureEnvironmentApi(environmentId).orchestration,
  maxInactiveEntries: MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES,
  maxInactiveChars: MAX_INACTIVE_CHECKPOINT_DIFF_CHARS,
});

export const {
  checkpointDiffStateAtom,
  executeCheckpointDiffRequest,
  watchCheckpointDiff,
  evictCheckpointDiffsForThread,
  invalidateCheckpointDiff,
  invalidateAllCheckpointDiffs,
  clearCheckpointDiffState,
} = store;

export const resetCheckpointDiffStateForTests = clearCheckpointDiffState;

/**
 * Drops one environment's unwatched cached diffs; diffs still on screen stay,
 * and other environments' diffs are untouched.
 */
export function clearCheckpointDiffCacheForEnvironment(environmentId: EnvironmentId): void {
  store.clearUnwatchedCheckpointDiffsForEnvironment(environmentId);
}
