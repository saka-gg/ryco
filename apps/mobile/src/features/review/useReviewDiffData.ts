import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import {
  readCheckpointDiffFileIndex,
  type CheckpointDiffFileIndex,
  type CheckpointDiffFilePatchState,
} from "@ryco/client-runtime/rpc/checkpointDiffFiles";

import { inferCheckpointTurnCountByTurnId } from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { TurnDiffSummary } from "@ryco/client-runtime/state/threads";

import {
  checkpointDiffCacheKey,
  checkpointDiffFilePatches,
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
    // The file list first; each file's patch loads when it is opened (D6).
    fileIndex: true,
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

/** The diff's file list, from a node that sends one or split from a whole diff. */
export function useCheckpointDiffFileIndex(
  state: CheckpointDiffState,
): CheckpointDiffFileIndex | null {
  const data = state.data;
  return useMemo(() => (data ? readCheckpointDiffFileIndex(data) : null), [data]);
}

/** One file's patch, loaded once the file is opened and kept by its commit pair. */
export function useCheckpointDiffFilePatch(
  input: CheckpointDiffInput,
  index: CheckpointDiffFileIndex,
  file: number,
  open: boolean,
): CheckpointDiffFilePatchState {
  const key = checkpointDiffFilePatches.filePatchKey(input, index, file);
  useEffect(() => {
    if (open) checkpointDiffFilePatches.loadFilePatch(input, index, file);
    // The key names the input, the commit pair and the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);
  return useAtomValue(checkpointDiffFilePatches.filePatchAtom(key));
}
