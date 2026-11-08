import type { VcsStatusResult } from "@ryco/contracts";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { WorktreeId } from "@ryco/contracts/worktree";
import { useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { errorMessageOr } from "../../lib/errorMessage";
import { firstRouteParam } from "../../lib/routeParams";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
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
 * The checkout's live Git status: one read, then the node's status stream
 * (which also answers after a reconnect).
 */
export function useVcsStatus(target: Pick<SourceControlTarget, "environmentId" | "cwd">) {
  const api = useEnvironmentApi(target.environmentId);
  const [status, setStatus] = useState<VcsStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { environmentId, cwd } = target;

  useEffect(() => {
    if (!api || !environmentId || !cwd) return;
    void readVcsStatus(environmentId, cwd, setStatus, setError);
    return api.vcs.onStatus({ cwd }, setStatus, {
      onResubscribe: () => void readVcsStatus(environmentId, cwd, setStatus, setError),
    });
  }, [api, cwd, environmentId]);

  const refresh = () =>
    environmentId && cwd
      ? readVcsStatus(environmentId, cwd, setStatus, setError)
      : Promise.resolve();

  return { status, error, connected: api !== undefined, refresh };
}

async function readVcsStatus(
  environmentId: EnvironmentId,
  cwd: string,
  setStatus: (status: VcsStatusResult) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    setStatus(await ensureEnvironmentApi(environmentId).vcs.refreshStatus({ cwd }));
  } catch (cause) {
    setError(errorMessageOr(cause, "Git status could not be read."));
  }
}
