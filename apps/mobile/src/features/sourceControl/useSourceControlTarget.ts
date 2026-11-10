import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { WorktreeId } from "@ryco/contracts/worktree";
import { useCallback, useEffect } from "react";

import { errorMessageOr } from "../../lib/errorMessage";
import { firstRouteParam } from "../../lib/routeParams";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { isLiveAnswer, vcsStatusQuery } from "../../rpc/sourceControlAtoms";
import { useMobileQuery } from "../../rpc/useMobileQuery";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { resolveCheckoutCwd } from "./gitToolsModel";

export type SourceControlRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly worktreeId?: string;
};

/**
 * The checkout a Git screen works on, from its route params: the project's
 * folder, or one of its worktrees. Shared by every source-control route so they
 * resolve the same `cwd` and the same mutation readiness.
 */
export function useSourceControlTarget(params: SourceControlRouteParams) {
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const projectIdRaw = firstRouteParam(params.projectId);
  const worktreeIdRaw = firstRouteParam(params.worktreeId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const worktreeId = worktreeIdRaw ? WorktreeId.make(worktreeIdRaw) : null;
  const { projects, worktrees } = useHomeWorkspaceData();
  const environments = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const worktree = worktreeId
    ? worktrees.find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          candidate.projectId === projectId &&
          candidate.id === worktreeId,
      )
    : null;
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const capabilities = environmentId
    ? (configs.get(environmentId)?.environment.capabilities ?? null)
    : null;
  return {
    environmentId,
    projectId,
    worktreeId,
    project: project ?? null,
    worktree: worktree ?? null,
    environment: environment ?? null,
    environmentLabel: environment?.label ?? environmentId ?? "Node",
    cwd: resolveCheckoutCwd({ worktreeId, worktree: worktree ?? null, project: project ?? null }),
    /** The route names a worktree this device does not know (yet): nothing may act. */
    worktreeMissing: worktreeId !== null && !worktree,
    mutable: environment?.mutationReady === true,
    capabilities,
    /** Route params for the sibling Git screens of this checkout. */
    routeParams:
      environmentId && projectId
        ? {
            environmentId,
            projectId,
            ...(worktreeId ? { worktreeId } : {}),
          }
        : null,
  };
}

export type SourceControlTarget = ReturnType<typeof useSourceControlTarget>;

/**
 * The checkout's Git status: the last answer kept on this device at once,
 * then one read and the node's status stream (which also answers after a
 * reconnect). `live` is false while only a saved answer shows: actions wait
 * for the node's own.
 */
export function useVcsStatus(target: Pick<SourceControlTarget, "environmentId" | "cwd">) {
  const api = useEnvironmentApi(target.environmentId);
  const { environmentId, cwd } = target;
  const input = { environmentId, cwd };
  const read = useMobileQuery(vcsStatusQuery, input, environmentId);
  const cacheKey = vcsStatusQuery.keyOf(input);

  useEffect(() => {
    if (!api || cacheKey === null || !cwd) return;
    return api.vcs.onStatus(
      { cwd },
      (status) => vcsStatusQuery.writeData(cacheKey, () => status, { live: true }),
      { onResubscribe: () => vcsStatusQuery.refresh(cacheKey) },
    );
  }, [api, cacheKey, cwd]);

  const refetch = read.refetch;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    status: read.data,
    error: read.error === null ? null : errorMessageOr(read.error, "Git status could not be read."),
    connected: api !== undefined,
    live: isLiveAnswer(read),
    refreshing: read.isFetching,
    refresh,
  };
}
