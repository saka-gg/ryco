import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSortOrder } from "@ryco/contracts/settings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary, SidebarWorktreeSummary } from "../../types";
import { sortThreadsWithPinned } from "../Sidebar.logic";
import { composeSidebarTree } from "./hooks/useSidebarTree";
import { adaptProjectForSidebarTree } from "./sidebarTreeAdapters";

const EMPTY_KEYS: readonly string[] = [];

function sameElements<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function groupByLogicalProjectKey<T>(
  items: readonly T[],
  logicalProjectKeyOf: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = logicalProjectKeyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

interface ProjectThreadKeysInput {
  readonly project: SidebarProjectSnapshot;
  readonly threads: readonly SidebarThreadSummary[];
  readonly worktrees: readonly SidebarWorktreeSummary[];
  readonly sortOrder: SidebarThreadSortOrder;
  readonly pinnedThreadKeys: ReadonlySet<string>;
  readonly projectExpanded: boolean;
  /** The routed thread; only consulted while the project is collapsed. */
  readonly activeThreadKey: string | null;
}

/**
 * Keyboard-traversal order of one project's visible threads: the order of the
 * project tree the Sidebar renders (worktree nodes, then their sessions).
 */
export function computeSidebarProjectThreadKeys(input: ProjectThreadKeysInput): readonly string[] {
  const projectThreads = sortThreadsWithPinned({
    threads: input.threads,
    sortOrder: input.sortOrder,
    pinnedThreadKeys: input.pinnedThreadKeys,
    getThreadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  });
  const activeThreadKey = input.activeThreadKey ?? undefined;
  const pinnedCollapsedThreadKey =
    !input.projectExpanded && activeThreadKey
      ? projectThreads.some(
          (thread) =>
            thread.archivedAt === null &&
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
        )
        ? activeThreadKey
        : null
      : null;
  if (!input.projectExpanded && !pinnedCollapsedThreadKey) {
    return EMPTY_KEYS;
  }

  const treeInput = adaptProjectForSidebarTree({
    project: input.project,
    threads: projectThreads,
    worktrees: input.worktrees,
  });
  const treeProject = composeSidebarTree({
    nowMs: 0,
    projects: [treeInput.project],
    threads: treeInput.threads,
    worktrees: treeInput.worktrees,
  }).projects[0];
  if (!treeProject) {
    return EMPTY_KEYS;
  }

  return treeProject.worktrees.flatMap((worktree) =>
    worktree.sessions
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
      .filter((threadKey) => input.projectExpanded || threadKey === pinnedCollapsedThreadKey),
  );
}

export interface SidebarProjectThreadKeysCache {
  /**
   * Returns `next` with each group replaced by the previous array for that key
   * when it holds the same elements, so per-project consumers see a stable
   * identity for projects a store commit did not touch.
   */
  readonly shareGroups: <T>(slot: string, next: Map<string, T[]>) => Map<string, T[]>;
  /** Memoized `computeSidebarProjectThreadKeys`, keyed by project. */
  readonly projectThreadKeys: (input: ProjectThreadKeysInput) => readonly string[];
}

/**
 * Per-project memoization for the Sidebar's traversal order. A streaming
 * thread changes one project's thread array; every other project reuses its
 * previous tree instead of re-running sort + adapt + compose for all of them.
 */
export function createSidebarProjectThreadKeysCache(): SidebarProjectThreadKeysCache {
  const groupsBySlot = new Map<string, Map<string, unknown[]>>();
  const keysByProject = new Map<
    string,
    { readonly input: ProjectThreadKeysInput; readonly keys: readonly string[] }
  >();
  return {
    shareGroups: <T>(slot: string, next: Map<string, T[]>) => {
      const previous = groupsBySlot.get(slot) as Map<string, T[]> | undefined;
      if (previous !== undefined) {
        for (const [key, group] of next) {
          const previousGroup = previous.get(key);
          if (previousGroup !== undefined && sameElements(previousGroup, group)) {
            next.set(key, previousGroup);
          }
        }
      }
      groupsBySlot.set(slot, next as Map<string, unknown[]>);
      return next;
    },
    projectThreadKeys: (input) => {
      const projectKey = input.project.projectKey;
      const cached = keysByProject.get(projectKey);
      if (
        cached !== undefined &&
        cached.input.project === input.project &&
        cached.input.threads === input.threads &&
        cached.input.worktrees === input.worktrees &&
        cached.input.sortOrder === input.sortOrder &&
        cached.input.pinnedThreadKeys === input.pinnedThreadKeys &&
        cached.input.projectExpanded === input.projectExpanded &&
        cached.input.activeThreadKey === input.activeThreadKey
      ) {
        return cached.keys;
      }
      const keys = computeSidebarProjectThreadKeys(input);
      keysByProject.set(projectKey, { input, keys });
      return keys;
    },
  };
}
