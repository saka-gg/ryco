import {
  createLocalChangesController,
  type LocalChangesStagedCommit,
} from "@ryco/client-runtime/state/comparison";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ThreadToastData } from "../components/ui/toast";
import { ensureEnvironmentApi } from "../environmentApi";
import { createGitActionReporter } from "../gitActionNotices";
import { useEnvironmentServerConfigSelector } from "../hooks/useChatsAvailability";
import { randomUUID } from "../lib/utils";
import {
  beginMutationTracking,
  endMutationTracking,
  gitScopeKey,
  invalidateScopes,
} from "./gitAtoms";
import { GIT_USER_ACTION_KIND, gitMutationTrackingKey } from "./useGit";
import { useRepositoryReadLifecycle } from "./useRepositoryReadLifecycle";

// Module level, so unrelated config pushes (provider probes) never re-render.
const selectStagedOnlyCommit = (config: ServerConfig | null): boolean =>
  config?.environment.capabilities.stagedOnlyCommit === true;

/**
 * Commits exactly the reviewed index, reported like the git controls' commits:
 * on the checkout's crown or a toast, and as its running git action.
 */
async function commitStagedChanges(
  environmentId: EnvironmentId,
  commit: LocalChangesStagedCommit,
  toastData: ThreadToastData | undefined,
): Promise<void> {
  const actionId = randomUUID();
  const reporter = createGitActionReporter({
    id: actionId,
    kind: "commit",
    environmentId,
    cwd: commit.cwd,
    toastData,
  });
  reporter.running("Committing staged changes...");
  const trackingKey = gitMutationTrackingKey(
    GIT_USER_ACTION_KIND.runStackedAction,
    environmentId,
    commit.cwd,
  );
  beginMutationTracking(trackingKey);
  try {
    const result = await ensureEnvironmentApi(environmentId).git.runStackedAction(
      {
        actionId,
        cwd: commit.cwd,
        action: "commit",
        stagedOnly: { expectedRevision: commit.expectedRevision },
      },
      {
        onProgress: (event) => {
          if (event.kind === "phase_started") reporter.running(event.label);
          else if (event.kind === "hook_started") reporter.running(`Running ${event.hookName}...`);
        },
      },
    );
    reporter.succeeded({ title: result.toast.title, description: result.toast.description });
  } catch (error) {
    reporter.failed({
      title: "Commit failed",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    throw error;
  } finally {
    endMutationTracking(trackingKey);
  }
}

export function useLocalChanges(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled: boolean,
) {
  const controller = useMemo(
    () =>
      createLocalChangesController({
        cwd: cwd ?? "",
        read: () => {
          if (!environmentId || !cwd) return Promise.reject(new Error("Repository unavailable."));
          return ensureEnvironmentApi(environmentId).vcs.readLocalChanges({ cwd });
        },
        apply: async (input) => {
          if (!environmentId) throw new Error("Repository unavailable.");
          await ensureEnvironmentApi(environmentId).vcs.applyIndexPatch(input);
        },
      }),
    [environmentId, cwd],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useRepositoryReadLifecycle(controller, environmentId, cwd, enabled, controller.refresh);
  // Older nodes drop `stagedOnly` and would commit every change.
  const stagedOnlyCommit = useEnvironmentServerConfigSelector(
    environmentId,
    selectStagedOnlyCommit,
  );
  const commitStaged = useCallback(
    async (toastData?: ThreadToastData) => {
      if (!environmentId || !cwd) return;
      const committed = await controller.commitStaged((commit) =>
        commitStagedChanges(environmentId, commit, toastData),
      );
      // After the controller's own refresh: other reads of this checkout (comparisons, refs).
      if (committed) invalidateScopes([gitScopeKey(cwd)]);
    },
    [controller, environmentId, cwd],
  );
  return {
    ...state,
    refresh: controller.refresh,
    apply: controller.apply,
    commitStaged: stagedOnlyCommit ? commitStaged : null,
  };
}
