/**
 * Starts the pull request page's list reads from the route loader: the state
 * list plus the "authored" and "review requested" lists, the same keys the
 * page watches. They then run in parallel with the page chunk and the page's
 * own repository resolution instead of after mount, and the page adopts them
 * from the shared list cache (an in-flight read is joined, a fresh one kept).
 */
import type { ChangeRequestInvolvement, EnvironmentId } from "@ryco/contracts";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";

import { getGitStatusSnapshot } from "../../lib/gitStatusState";
import { projectCheckoutKey } from "../../projectCheckouts.logic";
import { changeRequestListBinding } from "../../rpc/sourceControlAtoms";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import {
  derivePullRequestsCapabilities,
  PULL_REQUESTS_LIST_LIMIT,
  shouldReadInvolvementLists,
} from "./pullRequestsModel.logic";
import { resolvePullRequestsStateFilter, type PullRequestsSearch } from "./pullRequestsSearch";

export interface PullRequestListPrefetchTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

interface PrefetchProject extends ProjectKindCarrier {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * The checkout the page resolves without waiting for anything: the URL's
 * project, else the last repository chosen. Anything else (recent activity,
 * the first project, a project that has not synced yet) is left to the page.
 */
export function resolvePullRequestListPrefetchTarget(input: {
  readonly search: Pick<PullRequestsSearch, "env" | "project">;
  readonly projects: ReadonlyArray<PrefetchProject>;
  readonly lastRepositoryKey: string | null;
}): PullRequestListPrefetchTarget | null {
  const { search } = input;
  const candidates = input.projects.filter((project) => !isChatProject(project));
  const match =
    search.project !== undefined
      ? candidates.find(
          (project) =>
            project.id === search.project &&
            (search.env === undefined || project.environmentId === search.env),
        )
      : input.lastRepositoryKey !== null
        ? candidates.find(
            (project) =>
              projectCheckoutKey(project.environmentId, project.id) === input.lastRepositoryKey,
          )
        : undefined;
  return match ? { environmentId: match.environmentId, cwd: match.cwd } : null;
}

/** The list keys the page reads for `target`, as `usePullRequestsModel` builds them. */
export function pullRequestListPrefetchInputs(input: {
  readonly target: PullRequestListPrefetchTarget;
  readonly search: Pick<PullRequestsSearch, "state">;
  readonly readInvolvement: boolean;
}) {
  const listInput = (involvement?: ChangeRequestInvolvement) => ({
    environmentId: input.target.environmentId,
    cwd: input.target.cwd,
    state: resolvePullRequestsStateFilter(input.search),
    limit: PULL_REQUESTS_LIST_LIMIT,
    ...(involvement !== undefined ? { involvement } : {}),
  });
  return input.readInvolvement
    ? [listInput(), listInput("authored"), listInput("review-requested")]
    : [listInput()];
}

export function prefetchPullRequestLists(search: PullRequestsSearch): void {
  const target = resolvePullRequestListPrefetchTarget({
    search,
    projects: selectProjectsAcrossEnvironments(useStore.getState()),
    lastRepositoryKey: usePullRequestsLayoutStore.getState().lastRepositoryKey,
  });
  if (target === null) return;
  // The page reads the involvement lists until its host is known not to filter.
  const provider = getGitStatusSnapshot(target, "summary").data?.sourceControlProvider ?? null;
  const readInvolvement = shouldReadInvolvementLists({
    listEnabled: true,
    provider,
    capabilities: derivePullRequestsCapabilities(provider),
  });
  for (const listInput of pullRequestListPrefetchInputs({ target, search, readInvolvement })) {
    // A watch starts the read unless one is fresh or in flight; releasing it
    // right away leaves the result cached for the page's own watch.
    changeRequestListBinding.watch(listInput)();
  }
}
