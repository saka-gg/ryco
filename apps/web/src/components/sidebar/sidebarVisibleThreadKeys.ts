import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";

import type { SidebarTreeStructureProject } from "./hooks/useSidebarTree";

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
