import type { EnvironmentId } from "@ryco/contracts";
import type {
  Project,
  SidebarThreadOrStub,
  SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import {
  getThreadSortTimestamp,
  isUnarchivedThreadEntry,
  sortThreads,
} from "@ryco/client-runtime/state/threads";

import {
  deriveLogicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingMode,
} from "../lib/logicalProject";

// Pure home grouping (§3-2). Kept free of react / the zustand store / platform KV
// so it stays node-testable (those pull in expo-sqlite / react-native which cannot
// load in the vp/node test env). The React hook lives in homeData.ts.
//
// MVP shape: a plain project-grouped list — single active partition, no settlement
// (§3-4), no pending-new-task rows (§3-6), no PR badges (§3-7). Grouping keys stay
// algorithm-identical to server/web via logicalProject (§3-3) so they never diverge.

const DEFAULT_THREAD_SORT_ORDER = "updated_at" as const;

export interface HomeThreadGroup {
  /** Logical project key (repository- or path-scoped). */
  readonly key: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}

function projectRefKey(environmentId: EnvironmentId, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

export function resolveHomeGroupingMode(
  projectGroupingEnabled: boolean | undefined,
): ProjectGroupingMode {
  // Upstream: undefined -> "repository", false -> "separate".
  return projectGroupingEnabled === false ? "separate" : "repository";
}

/**
 * Partition unarchived threads into project groups keyed by the logical project
 * key, each sorted by recency, groups ordered by their most recent thread.
 */
export function buildHomeThreadGroups(input: {
  readonly projects: ReadonlyArray<Project>;
  /** Archived threads, stubs among them, are left out. */
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly groupingMode: ProjectGroupingMode;
}): ReadonlyArray<HomeThreadGroup> {
  const projectByRef = new Map<string, Project>();
  for (const project of input.projects) {
    projectByRef.set(projectRefKey(project.environmentId, project.id), project);
  }

  const groups = new Map<
    string,
    { environmentId: EnvironmentId; members: Project[]; threads: SidebarThreadSummary[] }
  >();

  const ensureGroup = (key: string, environmentId: EnvironmentId) => {
    let group = groups.get(key);
    if (!group) {
      group = { environmentId, members: [], threads: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const project of input.projects) {
    const key = deriveLogicalProjectKey(project, { groupingMode: input.groupingMode });
    ensureGroup(key, project.environmentId).members.push(project);
  }

  for (const thread of input.threads) {
    if (!isUnarchivedThreadEntry(thread)) continue;
    const project = projectByRef.get(projectRefKey(thread.environmentId, thread.projectId));
    if (!project) continue;
    const key = deriveLogicalProjectKey(project, { groupingMode: input.groupingMode });
    ensureGroup(key, thread.environmentId).threads.push(thread);
  }

  const result: HomeThreadGroup[] = [];
  for (const [key, group] of groups) {
    if (group.threads.length === 0) continue;
    const representative = group.members[0];
    result.push({
      key,
      label: representative
        ? deriveProjectGroupLabel({ representative, members: group.members })
        : key,
      environmentId: group.environmentId,
      threads: sortThreads(group.threads, DEFAULT_THREAD_SORT_ORDER),
    });
  }

  result.sort((left, right) => {
    const leftLatest = left.threads[0]
      ? getThreadSortTimestamp(left.threads[0], DEFAULT_THREAD_SORT_ORDER)
      : Number.NEGATIVE_INFINITY;
    const rightLatest = right.threads[0]
      ? getThreadSortTimestamp(right.threads[0], DEFAULT_THREAD_SORT_ORDER)
      : Number.NEGATIVE_INFINITY;
    if (rightLatest !== leftLatest) return rightLatest > leftLatest ? 1 : -1;
    return left.label.localeCompare(right.label);
  });

  return result;
}
