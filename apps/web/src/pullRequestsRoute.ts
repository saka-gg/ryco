import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import type {
  PullRequestsSearch,
  PullRequestsTab,
} from "./components/pullRequests/pullRequestsSearch";

export const PULL_REQUESTS_ROUTE_PATH = "/pull-requests" as const;

/**
 * Router location for the pull requests page itself: a given repository, or
 * (none given) the last one used. The palette, its per-repository submenu and
 * the `pullRequests.open` command all open the page through this.
 */
export function buildPullRequestsPageLocation(input?: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): { readonly to: typeof PULL_REQUESTS_ROUTE_PATH; readonly search: PullRequestsSearch } {
  return {
    to: PULL_REQUESTS_ROUTE_PATH,
    search: input ? { env: input.environmentId, project: input.projectId } : {},
  };
}

/** Router location for a change request on the pull requests page. */
export function buildPullRequestLocation(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly number: number;
  readonly tab?: PullRequestsTab;
}): { readonly to: typeof PULL_REQUESTS_ROUTE_PATH; readonly search: PullRequestsSearch } {
  return {
    to: PULL_REQUESTS_ROUTE_PATH,
    search: {
      env: input.environmentId,
      project: input.projectId,
      pr: input.number,
      ...(input.tab && input.tab !== "conversation" ? { tab: input.tab } : {}),
    },
  };
}

/** ⌘/Ctrl-click (or a middle click) keeps the host link; a plain click stays in the app. */
export function prefersExternalPullRequestLink(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly button?: number;
}): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}
