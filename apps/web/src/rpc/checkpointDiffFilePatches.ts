import { createCheckpointDiffFilePatches } from "@ryco/client-runtime/rpc/checkpointDiffFiles";

import { ensureEnvironmentApi } from "../environmentApi";

/**
 * Turn diffs read file by file (D6): each file's patch, kept by its checkpoint
 * commit pair, so it never goes stale. Only the diff panel's lazy chunk loads it.
 */
export const checkpointDiffFilePatches = createCheckpointDiffFilePatches({
  resolveOrchestrationApi: (environmentId) => ensureEnvironmentApi(environmentId).orchestration,
  maxRetainedChars: 16 * 1024 * 1024,
});
