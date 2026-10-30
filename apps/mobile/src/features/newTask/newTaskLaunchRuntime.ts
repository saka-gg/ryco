import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId } from "@ryco/contracts";

import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId } from "../../lib/ids";
import {
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadExistsByRef,
  useStore,
} from "../../state/threadsRuntime";
import type { NewTaskLaunchDeps } from "./newTaskLaunch";

async function waitForAuthoritative(read: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`${label} was not confirmed`);
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
      waitForProject: (projectId) =>
        waitForAuthoritative(
          () =>
            selectProjectByRef(useStore.getState(), scopeProjectRef(environmentId, projectId)) !==
            undefined,
          "Project",
        ),
      waitForThread: ({ threadId, worktreeId: expectedWorktreeId }) =>
        waitForAuthoritative(() => {
          const state = useStore.getState();
          const ref = scopeThreadRef(environmentId, threadId);
          if (!selectThreadExistsByRef(state, ref)) return false;
          if (expectedWorktreeId === undefined) return true;
          const summary = selectSidebarThreadSummaryByRef(state, ref);
          return (summary?.worktreeId ?? null) === expectedWorktreeId;
        }, "Task"),
    },
  };
}
