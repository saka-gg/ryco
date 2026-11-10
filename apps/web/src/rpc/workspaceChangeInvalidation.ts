import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { createWorkspaceChangeQueue } from "@ryco/client-runtime/state/orchestration";
import { projectScriptCwd } from "@ryco/shared/projectScripts";

import { selectEnvironmentState, useStore } from "~/store";
import { notifyCheckoutFilesChanged } from "./checkoutFileChanges";
import { invalidateCheckpointDiffChanges } from "./providerAtoms";

/** The checkout a thread's composer searches: its worktree, else its project root. */
export function resolveThreadCheckoutCwd(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | null {
  const environment = selectEnvironmentState(useStore.getState(), environmentId);
  const shell = environment.threadShellById[threadId];
  if (!shell) return null;
  const project = environment.projectById[shell.projectId];
  if (!project) return null;
  return projectScriptCwd({ project: { cwd: project.cwd }, worktreePath: shell.worktreePath });
}

/**
 * The web binding of the shared workspace change queue: a flush drops the
 * `@` search, file tree and file reads of the changed checkouts (their lazily
 * loaded caches listen through `onCheckoutFilesChanged`) and only the
 * checkpoint diffs whose ranges changed.
 */
export function createWebWorkspaceChangeQueue() {
  return createWorkspaceChangeQueue({
    // Resolved per call: the runtime service creates its queue while this
    // module's imports may still be initializing (they import the runtime).
    resolveThreadCwd: (environmentId, threadId) =>
      resolveThreadCheckoutCwd(environmentId, threadId),
    invalidateCheckout: (environmentId, cwd) => notifyCheckoutFilesChanged(environmentId, cwd),
    invalidateCheckpointDiffs: (changes) => invalidateCheckpointDiffChanges(changes),
  });
}
