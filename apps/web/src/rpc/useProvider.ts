import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import {
  type CheckpointDiffInput,
  type CheckpointDiffState,
  checkpointDiffCacheKey,
  checkpointDiffStateAtom,
  DISABLED_CHECKPOINT_DIFF_ATOM,
  DISABLED_CHECKPOINT_DIFF_STATE,
  isCheckpointDiffEnabled,
  watchCheckpointDiff,
} from "./providerAtoms";

/**
 * Atom-backed replacement for the previous React Query checkpoint diff hook.
 * Preserves the `data` / `error` / `isLoading` surface so consuming components
 * do not need to change shape, plus checkpoint error normalization and
 * retry/backoff semantics (implemented inside `providerAtoms`).
 */
export function useCheckpointDiff(input: CheckpointDiffInput): CheckpointDiffState {
  const {
    environmentId,
    threadId,
    fromTurnCount,
    toTurnCount,
    ignoreWhitespace,
    cacheScope,
    cacheSlot,
  } = input;
  const enabled = input.enabled;
  const key = isCheckpointDiffEnabled(input) ? checkpointDiffCacheKey(input) : null;

  useEffect(() => {
    if (key === null) {
      return;
    }
    return watchCheckpointDiff({
      environmentId,
      threadId,
      fromTurnCount,
      toTurnCount,
      ignoreWhitespace,
      ...(cacheScope !== undefined ? { cacheScope } : {}),
      ...(cacheSlot !== undefined ? { cacheSlot } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }, [
    key,
    environmentId,
    threadId,
    fromTurnCount,
    toTurnCount,
    ignoreWhitespace,
    cacheScope,
    cacheSlot,
    enabled,
  ]);

  const state = useAtomValue(
    key !== null ? checkpointDiffStateAtom(key) : DISABLED_CHECKPOINT_DIFF_ATOM,
  );
  return key === null ? DISABLED_CHECKPOINT_DIFF_STATE : state;
}
