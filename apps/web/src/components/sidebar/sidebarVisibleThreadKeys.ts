import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import type { ProjectId } from "@ryco/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@ryco/contracts/settings";

import type { DraftThreadState } from "../../composerDraftStore";
import type { SidebarProjectTreeRow } from "../../sidebarProjectFolders";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary, SidebarWorktreeSummary } from "../../types";
import { sortProjectsForSidebar } from "../Sidebar.logic";
import type { SidebarTreeStructureProject } from "./hooks/useSidebarTree";
import type { SidebarProjectTreeCache } from "./sidebarProjectTreeCache";

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
  /** The project's tree structure, from the shared `SidebarProjectTreeCache`. */
  readonly structure: SidebarTreeStructureProject | null;
  readonly projectExpanded: boolean;
  /** The routed thread; only consulted while the project is collapsed. */
  readonly activeThreadKey: string | null;
}

/**
 * Keyboard-traversal order of one project's visible threads: the order of the
 * project tree the Sidebar renders (worktree nodes, then their sessions). A
 * collapsed project shows only the routed thread, when it is one of them.
 */
export function computeSidebarProjectThreadKeys(input: ProjectThreadKeysInput): readonly string[] {
  if (input.structure === null) return EMPTY_KEYS;
  if (!input.projectExpanded && !input.activeThreadKey) return EMPTY_KEYS;
  const keys = input.structure.worktrees.flatMap((worktree) =>
    worktree.threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  if (input.projectExpanded) return keys;
  const active = keys.filter((threadKey) => threadKey === input.activeThreadKey);
  return active.length === 0 ? EMPTY_KEYS : active;
}

export interface SidebarProjectThreadKeysCache {
  /**
   * Returns `next` with each group replaced by the previous array for that key
   * when it holds the same elements, so per-project consumers see a stable
   * identity for projects a store commit did not touch.
   */
  readonly shareGroups: <T>(slot: string, next: Map<string, T[]>) => Map<string, T[]>;
  /** Memoized `computeSidebarProjectThreadKeys`, keyed by project. */
  readonly projectThreadKeys: (
    input: ProjectThreadKeysInput & { readonly projectKey: string },
  ) => readonly string[];
}

/**
 * Per-project memoization for the Sidebar's traversal order. A streaming
 * thread changes one project's thread array; every other project keeps its
 * tree structure (see `SidebarProjectTreeCache`) and so its keys.
 */
export function createSidebarProjectThreadKeysCache(): SidebarProjectThreadKeysCache {
  const groupsBySlot = new Map<string, Map<string, unknown[]>>();
  const keysByProject = new Map<
    string,
    {
      readonly input: ProjectThreadKeysInput & { readonly projectKey: string };
      readonly keys: readonly string[];
    }
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
      const projectKey = input.projectKey;
      const cached = keysByProject.get(projectKey);
      if (
        cached !== undefined &&
        cached.input.structure === input.structure &&
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

export interface SidebarProjectOrderInput {
  readonly sidebarProjects: readonly SidebarProjectSnapshot[];
  /** Unarchived threads; their activity orders the projects. */
  readonly visibleThreads: readonly SidebarThreadSummary[];
  readonly projectPhysicalKeyByScopedRef: ReadonlyMap<string, string>;
  readonly physicalToLogicalKey: ReadonlyMap<string, string>;
  readonly sidebarProjectByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly sortOrder: SidebarProjectSortOrder;
}

/** The sidebar's project order: logical projects sorted by their threads' activity. */
export function sortSidebarProjects(input: SidebarProjectOrderInput): SidebarProjectSnapshot[] {
  const sortableProjects = input.sidebarProjects.map((project) => ({
    ...project,
    id: project.projectKey,
  }));
  const sortableThreads = input.visibleThreads.map((thread) => {
    const scopedKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const physicalKey = input.projectPhysicalKeyByScopedRef.get(scopedKey) ?? scopedKey;
    return {
      ...thread,
      projectId: (input.physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
    };
  });
  return sortProjectsForSidebar(sortableProjects, sortableThreads, input.sortOrder).flatMap(
    (project) => {
      const resolvedProject = input.sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    },
  );
}

export interface SidebarVisibleThreadKeysInput {
  readonly projectTreeRows: readonly SidebarProjectTreeRow[];
  readonly projectExpandedById: Readonly<Record<string, boolean>>;
  readonly routeThreadKey: string | null;
  readonly projectThreadKeysCache: SidebarProjectThreadKeysCache;
  readonly projectTreeCache: SidebarProjectTreeCache;
  readonly threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>;
  readonly worktreesByProjectKey: ReadonlyMap<string, readonly SidebarWorktreeSummary[]>;
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
  readonly sortOrder: SidebarThreadSortOrder;
  readonly pinnedThreadKeys: ReadonlySet<string>;
}

const NO_THREADS: readonly SidebarThreadSummary[] = [];
const NO_WORKTREES: readonly SidebarWorktreeSummary[] = [];

/**
 * Keyboard traversal and jump order: every visible project's threads, in the
 * project tree's order. Memoized per project through the shared caches, so a
 * commit that changes one project's threads re-derives only that project.
 */
export function collectSidebarVisibleThreadKeys(input: SidebarVisibleThreadKeysInput): string[] {
  return input.projectTreeRows.flatMap((row) => {
    const projectsForRow =
      row.kind === "project" ? [row.project] : row.folder.expanded ? row.projects : [];
    return projectsForRow.flatMap((project) => {
      const projectExpanded = input.projectExpandedById[project.projectKey] ?? true;
      const activeThreadKey = projectExpanded ? null : input.routeThreadKey;
      // A collapsed project without a routed thread shows nothing to traverse.
      if (!projectExpanded && activeThreadKey === null) return [];
      return input.projectThreadKeysCache.projectThreadKeys({
        projectKey: project.projectKey,
        structure: input.projectTreeCache.structure({
          project,
          threads: input.threadsByProjectKey.get(project.projectKey) ?? NO_THREADS,
          drafts: input.projectTreeCache.draftThreadsSelector(project)({
            draftThreadsByThreadKey: input.draftThreadsByThreadKey,
          }),
          worktrees: input.worktreesByProjectKey.get(project.projectKey) ?? NO_WORKTREES,
          sortOrder: input.sortOrder,
          pinnedThreadKeys: input.pinnedThreadKeys,
        }),
        projectExpanded,
        activeThreadKey,
      });
    });
  });
}
