import { isUnsupportedRpcError } from "@ryco/client-runtime/rpc";
import type { EnvironmentApi, EnvironmentId, ProjectId } from "@ryco/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { readAndRememberProjectPreferences } from "./newDraftDefaults";
import { readEnvironmentServerConfig } from "./useChatsAvailability";

/** One prefetch per base and project in this window; the server reuses its fetch about as long. */
export const WORKTREE_SEND_PREFETCH_INTERVAL_MS = 30_000;

/** Nodes that answered the prefetch RPC with "Unknown request tag". */
const unsupportedEnvironments = new Set<EnvironmentId>();
const lastPrefetchAt = new Map<string, number>();

export interface WorktreeSendPrefetchInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The project checkout the worktree is created from. */
  readonly cwd: string;
  /** The base the send will name, e.g. `origin/main` or `origin/HEAD`. */
  readonly refName: string;
  readonly now?: () => number;
  readonly readApi?: (environmentId: EnvironmentId) => EnvironmentApi | undefined;
}

/**
 * Starts the work a first send into a new worktree waits for, while the user
 * is still writing: the node fetches the base from origin (its worktree
 * creation then reuses that fetch), and the project's effective preferences
 * are read so the send needs no preference round trip. Best effort: every
 * failure here leaves the send to do the work itself.
 */
export function prefetchWorktreeSend(input: WorktreeSendPrefetchInput): void {
  const now = input.now ?? Date.now;
  const key = `${input.environmentId}\u0000${input.projectId}\u0000${input.cwd}\u0000${input.refName}`;
  const previous = lastPrefetchAt.get(key);
  if (previous !== undefined && now() - previous < WORKTREE_SEND_PREFETCH_INTERVAL_MS) return;
  const api = (input.readApi ?? readEnvironmentApi)(input.environmentId);
  if (!api) return;
  lastPrefetchAt.set(key, now());

  const prefetchBase = api.vcs.prefetchWorktreeBase;
  if (prefetchBase && !unsupportedEnvironments.has(input.environmentId)) {
    void prefetchBase({ cwd: input.cwd, refName: input.refName }).catch((error: unknown) => {
      if (isUnsupportedRpcError(error)) unsupportedEnvironments.add(input.environmentId);
    });
  }
  void readAndRememberProjectPreferences({
    api,
    environmentId: input.environmentId,
    config: readEnvironmentServerConfig(input.environmentId),
    projectId: input.projectId,
  }).catch(() => undefined);
}

export function resetWorktreeSendPrefetchForTests(): void {
  unsupportedEnvironments.clear();
  lastPrefetchAt.clear();
}
