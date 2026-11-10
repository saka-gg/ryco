import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { createWorkspaceChangeQueue } from "@ryco/client-runtime/state/orchestration";
import { projectScriptCwd } from "@ryco/shared/projectScripts";

import { selectEnvironmentState, useStore } from "~/store";
import { invalidateProjectSearchEntries } from "./projectAtoms";
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

type CheckoutChangeListener = (environmentId: EnvironmentId, cwd: string | null) => void;
const checkoutChangeListeners = new Set<CheckoutChangeListener>();

/**
 * Lazily loaded file caches (the files panel's tree and reads) listen here
 * instead of being imported by the runtime service, which is on the boot path.
 * `cwd` null: every checkout of the environment.
 */
export function onCheckoutFilesChanged(listener: CheckoutChangeListener): () => void {
  checkoutChangeListeners.add(listener);
  return () => checkoutChangeListeners.delete(listener);
}

/**
 * The web binding of the shared workspace change queue: a flush drops the
 * `@` search, file tree and file reads of the changed checkouts and only the
 * checkpoint diffs whose ranges changed.
 */
export function createWebWorkspaceChangeQueue() {
  return createWorkspaceChangeQueue({
    // Resolved per call: the runtime service creates its queue while this
    // module's imports may still be initializing (they import the runtime).
    resolveThreadCwd: (environmentId, threadId) =>
      resolveThreadCheckoutCwd(environmentId, threadId),
    invalidateCheckout: (environmentId, cwd) => {
      invalidateProjectSearchEntries(cwd === null ? { environmentId } : { environmentId, cwd });
      for (const listener of checkoutChangeListeners) listener(environmentId, cwd);
    },
    invalidateCheckpointDiffs: (changes) => invalidateCheckpointDiffChanges(changes),
  });
}
