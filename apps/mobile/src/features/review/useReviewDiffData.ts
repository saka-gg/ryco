import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { inferCheckpointTurnCountByTurnId } from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { TurnDiffSummary } from "@ryco/client-runtime/state/threads";

import {
  checkpointDiffCacheKey,
  checkpointDiffStateAtom,
  watchCheckpointDiff,
  type CheckpointDiffInput,
  type CheckpointDiffState,
} from "../../rpc/checkpointDiffAtoms";

// §3-18: resolve the "review everything" turn range from the thread's
// turnDiffSummaries (superset of the old checkpoints). fromTurnCount 0 routes to
// getFullThreadDiff (§6); toTurnCount is the latest ready turn count.
export function buildFullThreadDiffInput(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  summaries: ReadonlyArray<TurnDiffSummary>,
  ignoreWhitespace: boolean,
): CheckpointDiffInput {
  const inferred = inferCheckpointTurnCountByTurnId([...summaries]);
  const toTurnCount = summaries.reduce((max, summary) => {
    const turnCount = summary.checkpointTurnCount ?? inferred[summary.turnId] ?? 0;
    return Math.max(max, turnCount);
  }, 0);
  return {
    environmentId,
    threadId,
    fromTurnCount: 0,
    toTurnCount,
    ignoreWhitespace,
    // Every completed turn makes a new full-range key; the slot drops the
    // superseded patch once nothing shows it, instead of keeping one per turn.
    cacheSlot: "conversation",
  };
}

// React binding over the §6 cache: retain the entry while mounted (ref-count) and
// read its atom state. RegistryContext is mounted at the app root.
export function useCheckpointDiff(input: CheckpointDiffInput): CheckpointDiffState {
  const key = checkpointDiffCacheKey(input);
  useEffect(
    () => watchCheckpointDiff(input),
    // Re-subscribe only when the cache key changes; `input` is captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return useAtomValue(checkpointDiffStateAtom(key));
}
