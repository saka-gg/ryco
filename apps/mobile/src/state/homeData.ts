import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarWorktreesAcrossEnvironments,
  useStore,
} from "./threadsRuntime";
import {
  buildHomeThreadGroups,
  resolveHomeGroupingMode,
  type HomeThreadGroup,
} from "./homeGrouping";
import { usePreferences } from "./preferencesStore";

export { buildHomeThreadGroups, resolveHomeGroupingMode } from "./homeGrouping";
export type { HomeThreadGroup } from "./homeGrouping";

function filterEligible<T extends { readonly environmentId: string }>(
  values: ReadonlyArray<T>,
  eligibleEnvironmentIds: ReadonlySet<string> | undefined,
): ReadonlyArray<T> {
  if (!eligibleEnvironmentIds) return values;
  return values.filter((value) => eligibleEnvironmentIds.has(value.environmentId));
}

/**
 * Home's cross-environment slices, narrowed to the eligible environments.
 *
 * Each filtered array keeps its identity until its own slice or the eligible
 * set changes: Home's inbox and project models are memoized on these arrays,
 * and fresh `.filter()` results on every render rebuilt both models on every
 * scroll frame and store tick.
 */
export function useHomeWorkspaceData(eligibleEnvironmentIds?: ReadonlySet<string>) {
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const allWorktrees = useStore(useShallow(selectSidebarWorktreesAcrossEnvironments));
  const allThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useMemo(
    () => filterEligible(allProjects, eligibleEnvironmentIds),
    [allProjects, eligibleEnvironmentIds],
  );
  const worktrees = useMemo(
    () => filterEligible(allWorktrees, eligibleEnvironmentIds),
    [allWorktrees, eligibleEnvironmentIds],
  );
  const threads = useMemo(
    () => filterEligible(allThreads, eligibleEnvironmentIds),
    [allThreads, eligibleEnvironmentIds],
  );
  return useMemo(() => ({ projects, worktrees, threads }) as const, [projects, threads, worktrees]);
}

/**
 * The workspace data of the environments a screen lists (Home's machines, the
 * command palette's), so neither shows a project or thread from one it hides.
 * Keyed by the ids alone: a list rebuilt for a clock tick or a status change
 * keeps the same set, so the workspace rows are not refiltered.
 */
export function useListedEnvironmentsWorkspaceData(
  environments: ReadonlyArray<{ readonly environmentId: string }>,
) {
  const environmentKey = environments
    .map((environment) => environment.environmentId)
    .join("\u0000");
  const environmentIds = useMemo(
    () => new Set(environmentKey === "" ? [] : environmentKey.split("\u0000")),
    [environmentKey],
  );
  return useHomeWorkspaceData(environmentIds);
}

export function useHomeThreadGroups(): ReadonlyArray<HomeThreadGroup> {
  const preferences = usePreferences();
  const groupingMode = resolveHomeGroupingMode(preferences.projectGroupingEnabled);
  // Both selectors build a FRESH array every call (.flatMap across environments);
  // zustand v5's useStore has no equality arg, so without useShallow the snapshot
  // changes every render and React infinite-loops. useShallow memoizes per
  // component with a shallow compare (matches apps/web PhoneHome).
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  return buildHomeThreadGroups({ projects, threads, groupingMode });
}
