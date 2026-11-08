import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useShallow } from "zustand/react/shallow";

import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { pullRequestTabListFilters, type PullRequestListItemModel } from "./pullRequestListModel";
import {
  derivePullRequestRepositoryChoices,
  resolvePullRequestRepositoryChoice,
} from "./pullRequestRepositoriesModel";
import { usePullRequestList, useSourceControlProvider } from "./usePullRequestData";
import { usePullRequestTabState } from "./usePullRequestTabState";

/**
 * The PRs scope of the app's global search: pull requests of the repository
 * the PRs tab shows (any state), ranked by the shared list rules for the
 * query. Each result names the route that opens it.
 */
export interface PullRequestSearchResult {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  /** "acme/app · merged". */
  readonly subtitle: string;
  readonly route: {
    readonly name: "ProjectPullRequest";
    readonly params: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly number: string;
    };
  };
}

export interface PullRequestSearch {
  readonly results: ReadonlyArray<PullRequestSearchResult>;
  readonly loading: boolean;
  /** Why nothing can be searched (no repository, machine offline); null when it can. */
  readonly unavailable: string | null;
}

const STATE_WORD: Readonly<Record<string, string>> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

/** At most this many results, like the other scopes of the global search. */
export const PULL_REQUEST_SEARCH_LIMIT = 20;

export function usePullRequestSearch(query: string): PullRequestSearch {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environments = useHomeEnvironments();
  const tabState = usePullRequestTabState();
  const connected = new Set(
    environments
      .filter(
        (environment) =>
          environment.connectionState === "connected" ||
          environment.connectionState === "read-only",
      )
      .map((environment) => environment.environmentId),
  );
  const choices = derivePullRequestRepositoryChoices({
    projects,
    connected,
    environmentLabels: new Map(),
  });
  const choice = resolvePullRequestRepositoryChoice(choices, tabState.repositoryKey);
  const environmentId = choice?.environmentId ?? null;
  const cwd = choice?.cwd ?? null;
  const provider = useSourceControlProvider(environmentId, cwd);
  const trimmed = query.trim();
  const list = usePullRequestList({
    environmentId: trimmed.length > 0 ? environmentId : null,
    cwd,
    provider,
    filters: pullRequestTabListFilters({ segment: "all", state: "all", q: trimmed }),
  });
  if (choice === null) {
    return { results: [], loading: false, unavailable: "No repository with pull requests." };
  }
  if (trimmed.length === 0) return { results: [], loading: false, unavailable: null };
  const results = pullRequestSearchResults(list.screen.items, {
    label: choice.label,
    environmentId: choice.environmentId,
    projectId: choice.projectId,
  });
  return {
    results,
    loading: list.screen.status === "loading",
    unavailable: choice.connected ? null : "The machine with this repository is offline.",
  };
}

/** The list's rows as search results, in list order, up to the limit. */
export function pullRequestSearchResults(
  items: ReadonlyArray<PullRequestListItemModel>,
  repository: {
    readonly label: string;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  },
): ReadonlyArray<PullRequestSearchResult> {
  const results: PullRequestSearchResult[] = [];
  for (const item of items) {
    if (item.kind !== "row") continue;
    if (results.some((result) => result.number === item.row.number)) continue;
    const state = item.row.isDraft && item.row.state === "open" ? "draft" : item.row.state;
    results.push({
      key: `pr:${repository.environmentId}:${repository.projectId}:${item.row.number}`,
      number: item.row.number,
      title: item.row.title,
      subtitle: `${repository.label} · ${STATE_WORD[state] ?? state}`,
      route: {
        name: "ProjectPullRequest",
        params: {
          environmentId: repository.environmentId,
          projectId: repository.projectId,
          number: String(item.row.number),
        },
      },
    });
    if (results.length >= PULL_REQUEST_SEARCH_LIMIT) break;
  }
  return results;
}
