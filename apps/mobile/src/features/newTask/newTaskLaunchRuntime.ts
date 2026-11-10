import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  isArchivedThreadStub,
  waitForStoreCondition,
  type AppState,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId, newProjectId } from "../../lib/ids";
import {
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadExistsByRef,
  useStore,
} from "../../state/threadsRuntime";
import { delegateTaskChatStart, preflightTaskChatStart } from "../tasks/taskChatStart";
import type { NewTaskLaunchDeps } from "./newTaskLaunch";

/** How long a launch waits for the node to confirm what it created through the shell stream. */
const AUTHORITATIVE_WAIT_MS = 12_000;

/** Resolves the moment the shell stream shows it (a store subscription, never a poll). */
async function waitForAuthoritative(read: (state: AppState) => boolean, label: string) {
  if (!(await waitForStoreCondition({ ready: read, timeoutMs: AUTHORITATIVE_WAIT_MS }))) {
    throw new Error(`${label} was not confirmed`);
  }
}

/** Whether the node shows the thread with its first turn under way (not merely created). */
export function isNewTaskThreadStarted(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  const summary = selectSidebarThreadSummaryByRef(
    useStore.getState(),
    scopeThreadRef(environmentId, threadId),
  );
  return (
    summary !== undefined &&
    !isArchivedThreadStub(summary) &&
    (summary.latestTurn !== null || summary.latestUserMessageAt !== null)
  );
}

/**
 * The live environment's side of a New Task launch: its dispatch, the node's
 * worktree setup feed, and the waits for the project and thread the node
 * confirms through the shell stream.
 */
export function createNewTaskLaunchDeps(environmentId: EnvironmentId): NewTaskLaunchDeps {
  const api = ensureEnvironmentApi(environmentId);
  return {
    feedApi: api,
    newCommandId,
    controller: {
      dispatch: (command) => api.orchestration.dispatchCommand(command),
      delegate: (taskId, command) => delegateTaskChatStart(environmentId, taskId, command),
      preflightTask: (taskId) => preflightTaskChatStart(environmentId, taskId),
      threadStarted: (threadId) => isNewTaskThreadStarted(environmentId, threadId),
      freshChatIds: () => ({ projectId: newProjectId(), turnCommandId: newCommandId() }),
      waitForProject: (projectId) =>
        waitForAuthoritative(
          (state) =>
            selectProjectByRef(state, scopeProjectRef(environmentId, projectId)) !== undefined,
          "Project",
        ),
      waitForThread: ({ threadId, worktreeId: expectedWorktreeId }) =>
        waitForAuthoritative((state) => {
          const ref = scopeThreadRef(environmentId, threadId);
          if (!selectThreadExistsByRef(state, ref)) return false;
          if (expectedWorktreeId === undefined) return true;
          const summary = selectSidebarThreadSummaryByRef(state, ref);
          return (summary?.worktreeId ?? null) === expectedWorktreeId;
        }, "Task"),
    },
  };
}
