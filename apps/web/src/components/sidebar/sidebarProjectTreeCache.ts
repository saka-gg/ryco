import { createContext, useContext, useState } from "react";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSortOrder } from "@ryco/contracts/settings";

import type { DraftThreadState } from "../../composerDraftStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary, SidebarWorktreeSummary } from "../../types";
import { sortThreadsWithPinned } from "../Sidebar.logic";
import {
  composeSidebarTreeStructure,
  type SidebarTreeStructureProject,
  type SidebarTreeThread,
} from "./hooks/useSidebarTree";
import {
  adaptProjectForSidebarTree,
  createSidebarProjectDraftThreadsSelector,
  mergeSidebarThreadsWithDrafts,
} from "./sidebarTreeAdapters";

export interface SidebarProjectTreeInput {
  readonly project: SidebarProjectSnapshot;
  readonly threads: readonly SidebarThreadSummary[];
  /** From `draftThreadsSelector(project)`, so every consumer passes the same rows. */
  readonly drafts: readonly SidebarTreeThread[];
  readonly worktrees: readonly SidebarWorktreeSummary[];
  readonly sortOrder: SidebarThreadSortOrder;
  readonly pinnedThreadKeys: ReadonlySet<string>;
}

type DraftThreadsSelector = (state: {
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
}) => ReadonlyArray<SidebarTreeThread>;

/**
 * One tree structure per sidebar project, shared by the Sidebar's keyboard
 * traversal and the project's own rows, which used to compose the same tree
 * twice. Visits only change status pills, so the structure is built without
 * them and each consumer decorates it (`decorateSidebarTreeProject`).
 */
export interface SidebarProjectTreeCache {
  /** The project's draft rows; one selector per project, so its rows keep their identity. */
  readonly draftThreadsSelector: (project: SidebarProjectSnapshot) => DraftThreadsSelector;
  readonly structure: (input: SidebarProjectTreeInput) => SidebarTreeStructureProject | null;
}

interface CachedStructure {
  readonly input: SidebarProjectTreeInput;
  readonly sortedThreads: readonly SidebarTreeThread[];
  readonly structure: SidebarTreeStructureProject | null;
}

function sameElements<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const threadKeyOf = (thread: SidebarTreeThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function createSidebarProjectTreeCache(): SidebarProjectTreeCache {
  const selectors = new Map<
    string,
    { readonly project: SidebarProjectSnapshot; readonly select: DraftThreadsSelector }
  >();
  const structures = new Map<string, CachedStructure>();
  return {
    draftThreadsSelector: (project) => {
      const cached = selectors.get(project.projectKey);
      if (cached !== undefined && cached.project === project) return cached.select;
      const select = createSidebarProjectDraftThreadsSelector(project);
      selectors.set(project.projectKey, { project, select });
      return select;
    },
    structure: (input) => {
      const cached = structures.get(input.project.projectKey);
      if (
        cached !== undefined &&
        cached.input.project === input.project &&
        cached.input.threads === input.threads &&
        cached.input.drafts === input.drafts &&
        cached.input.worktrees === input.worktrees &&
        cached.input.sortOrder === input.sortOrder &&
        cached.input.pinnedThreadKeys === input.pinnedThreadKeys
      ) {
        return cached.structure;
      }
      const sortedThreads = sortThreadsWithPinned({
        threads: mergeSidebarThreadsWithDrafts(input.threads, input.drafts),
        sortOrder: input.sortOrder,
        pinnedThreadKeys: input.pinnedThreadKeys,
        getThreadKey: threadKeyOf,
      });
      // Another consumer asked with arrays of its own holding the same rows:
      // the structure it got is this one.
      if (
        cached !== undefined &&
        cached.input.project === input.project &&
        sameElements(cached.sortedThreads, sortedThreads) &&
        sameElements(cached.input.worktrees, input.worktrees)
      ) {
        structures.set(input.project.projectKey, { ...cached, input });
        return cached.structure;
      }
      const adapted = adaptProjectForSidebarTree({
        project: input.project,
        threads: sortedThreads,
        worktrees: input.worktrees,
      });
      const structure =
        composeSidebarTreeStructure({
          projects: [adapted.project],
          threads: adapted.threads,
          worktrees: adapted.worktrees,
        }).projects[0] ?? null;
      structures.set(input.project.projectKey, { input, sortedThreads, structure });
      return structure;
    },
  };
}

export const SidebarProjectTreeCacheContext = createContext<SidebarProjectTreeCache | null>(null);

/** The Sidebar's shared cache, or a private one where no Sidebar provides it. */
export function useSidebarProjectTreeCache(): SidebarProjectTreeCache {
  const shared = useContext(SidebarProjectTreeCacheContext);
  const [own] = useState(createSidebarProjectTreeCache);
  return shared ?? own;
}
