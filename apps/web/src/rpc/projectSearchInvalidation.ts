import type { EnvironmentId, OrchestrationEvent, ThreadId } from "@ryco/contracts";
import { CHECKPOINT_REVERT_ACTIVITY_KIND } from "@ryco/contracts/orchestration";
import { projectScriptCwd } from "@ryco/shared/projectScripts";

import { selectEnvironmentState, useStore } from "~/store";
import { invalidateProjectSearchEntries } from "./projectAtoms";

type InvalidateProjectSearchEntries = typeof invalidateProjectSearchEntries;

/**
 * The thread whose checkout an event changed files in, or null. A files-only revert
 * (`thread.files.revert`) changes files without `thread.reverted`: its journal row
 * reaching an end says so.
 */
function threadWithChangedFiles(event: OrchestrationEvent): ThreadId | null {
  if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
    return event.payload.threadId;
  }
  return isFinishedFilesRevert(event) ? event.payload.threadId : null;
}

function isFinishedFilesRevert(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  if (event.type !== "thread.activity-appended") return false;
  const { activity } = event.payload;
  if (activity.kind !== CHECKPOINT_REVERT_ACTIVITY_KIND) return false;
  const payload = activity.payload as {
    readonly status?: unknown;
    readonly rollbackConversation?: unknown;
  } | null;
  return (
    payload?.rollbackConversation === false &&
    payload.status !== "requested" &&
    payload.status !== "restoring-files"
  );
}

/**
 * Turn diffs and reverts change files in one thread's checkout. The queue
 * collects those checkouts across a throttled batch so the `@` search cache is
 * invalidated only for them, instead of for every environment and folder.
 * A thread whose checkout is unknown invalidates its whole environment.
 */
export interface ProjectSearchInvalidationQueue {
  readonly noteEvents: (
    environmentId: EnvironmentId,
    events: ReadonlyArray<OrchestrationEvent>,
  ) => void;
  readonly flush: () => void;
  readonly reset: () => void;
}

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

export function createProjectSearchInvalidationQueue(
  dependencies: {
    readonly resolveThreadCwd?: (environmentId: EnvironmentId, threadId: ThreadId) => string | null;
    readonly invalidate?: InvalidateProjectSearchEntries;
  } = {},
): ProjectSearchInvalidationQueue {
  // Resolved per call: the runtime service creates its queue while this
  // module's imports may still be initializing (they import the runtime).
  const resolveThreadCwd = (environmentId: EnvironmentId, threadId: ThreadId) =>
    (dependencies.resolveThreadCwd ?? resolveThreadCheckoutCwd)(environmentId, threadId);
  const invalidate: InvalidateProjectSearchEntries = (filter) =>
    (dependencies.invalidate ?? invalidateProjectSearchEntries)(filter);
  const pendingThreadsByEnvironment = new Map<EnvironmentId, Set<ThreadId>>();

  return {
    noteEvents: (environmentId, events) => {
      for (const event of events) {
        const threadId = threadWithChangedFiles(event);
        if (threadId === null) continue;
        let threads = pendingThreadsByEnvironment.get(environmentId);
        if (!threads) {
          threads = new Set();
          pendingThreadsByEnvironment.set(environmentId, threads);
        }
        threads.add(threadId);
      }
    },
    flush: () => {
      const pending = [...pendingThreadsByEnvironment];
      pendingThreadsByEnvironment.clear();
      for (const [environmentId, threadIds] of pending) {
        const cwds = new Set<string>();
        let unresolved = false;
        for (const threadId of threadIds) {
          const cwd = resolveThreadCwd(environmentId, threadId);
          if (cwd === null) {
            unresolved = true;
            break;
          }
          cwds.add(cwd);
        }
        if (unresolved) {
          invalidate({ environmentId });
          continue;
        }
        for (const cwd of cwds) {
          invalidate({ environmentId, cwd });
        }
      }
    },
    reset: () => {
      pendingThreadsByEnvironment.clear();
    },
  };
}
