import { useMemo } from "react";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { type SidebarThreadSortOrder } from "@ryco/contracts/settings";
import {
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  sortThreadsWithPinned,
} from "../../Sidebar.logic";
import { restatusSidebarTreeThread } from "../sidebarTreeAdapters";
import { useSidebarProjectTreeCache } from "../sidebarProjectTreeCache";
import { decorateSidebarTreeProject, type SidebarTreeThread } from "./useSidebarTree";
import type { SidebarThreadSummary, SidebarWorktreeSummary } from "../../../types";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { useUiStateStore } from "../../../uiStateStore";

const THREAD_PREVIEW_LIMIT = 6;

export function useSidebarProjectThreadPresentation(params: {
  project: SidebarProjectSnapshot;
  /** The project's server threads and its drafts, merged. */
  projectThreads: ReadonlyArray<SidebarThreadSummary>;
  sidebarThreads: ReadonlyArray<SidebarThreadSummary>;
  /** From the shared tree cache's `draftThreadsSelector(project)`. */
  projectDraftThreads: ReadonlyArray<SidebarTreeThread>;
  sidebarWorktrees: ReadonlyArray<SidebarWorktreeSummary>;
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | null>;
  threadSortOrder: SidebarThreadSortOrder;
  activeRouteThreadKey: string | null;
  projectExpanded: boolean;
  isThreadListExpanded: boolean;
}) {
  const {
    project,
    projectThreads,
    sidebarThreads,
    projectDraftThreads,
    sidebarWorktrees,
    lastVisitedAtByThreadKey,
    threadSortOrder,
    activeRouteThreadKey,
    projectExpanded,
    isThreadListExpanded,
  } = params;
  const pinnedThreadKeysRecord = useUiStateStore((state) => state.pinnedThreadKeys);
  const pinnedThreadKeys = useMemo(
    () =>
      new Set(
        Object.entries(pinnedThreadKeysRecord).flatMap(([threadKey, pinned]) =>
          pinned ? [threadKey] : [],
        ),
      ),
    [pinnedThreadKeysRecord],
  );

  const { projectStatus, visibleProjectThreads, orderedProjectThreadKeys } = useMemo(() => {
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
        },
      });
    };
    const visibleProjectThreads = sortThreadsWithPinned({
      threads: projectThreads.filter((thread) => thread.archivedAt === null),
      sortOrder: threadSortOrder,
      pinnedThreadKeys,
      getThreadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    });
    const projectStatus = resolveProjectStatusIndicator(
      visibleProjectThreads.map((thread) => resolveProjectThreadStatus(thread)),
    );
    return {
      orderedProjectThreadKeys: visibleProjectThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
      projectStatus,
      visibleProjectThreads,
    };
  }, [lastVisitedAtByThreadKey, pinnedThreadKeys, projectThreads, threadSortOrder]);

  const pinnedCollapsedThread = useMemo(() => {
    const activeThreadKey = activeRouteThreadKey ?? undefined;
    if (!activeThreadKey || projectExpanded) {
      return null;
    }
    return (
      visibleProjectThreads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
      ) ?? null
    );
  }, [activeRouteThreadKey, projectExpanded, visibleProjectThreads]);

  const {
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
  } = useMemo(() => {
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
        },
      });
    };
    const hasOverflowingThreads = visibleProjectThreads.length > THREAD_PREVIEW_LIMIT;
    const previewThreads =
      isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, THREAD_PREVIEW_LIMIT);
    const visibleThreadKeys = new Set(
      [...previewThreads, ...(pinnedCollapsedThread ? [pinnedCollapsedThread] : [])].map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    const renderedThreads = pinnedCollapsedThread
      ? [pinnedCollapsedThread]
      : visibleProjectThreads.filter((thread) =>
          visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
        );
    const hiddenThreads = visibleProjectThreads.filter(
      (thread) =>
        !visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    return {
      hasOverflowingThreads,
      hiddenThreadStatus: resolveProjectStatusIndicator(
        hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
      ),
      renderedThreads,
      showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
    };
  }, [
    isThreadListExpanded,
    lastVisitedAtByThreadKey,
    pinnedCollapsedThread,
    projectExpanded,
    visibleProjectThreads,
  ]);
  // The structure is shared with the Sidebar's traversal, which asks for the
  // same project first; visits only change status pills, applied here.
  const structure = useSidebarProjectTreeCache().structure({
    project,
    threads: sidebarThreads,
    drafts: projectDraftThreads,
    worktrees: sidebarWorktrees,
    sortOrder: threadSortOrder,
    pinnedThreadKeys,
  });
  const treeProject = useMemo(
    () =>
      structure === null
        ? null
        : decorateSidebarTreeProject(structure, {
            nowMs: Date.now(),
            restatusThread: (thread) =>
              restatusSidebarTreeThread(
                thread,
                lastVisitedAtByThreadKey.get(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                ),
              ),
          }),
    [lastVisitedAtByThreadKey, structure],
  );
  const visibleTreeThreadKeys = useMemo(() => {
    if (projectExpanded) {
      return null;
    }
    if (!pinnedCollapsedThread) {
      return new Set<string>();
    }
    return new Set([
      scopedThreadKey(
        scopeThreadRef(pinnedCollapsedThread.environmentId, pinnedCollapsedThread.id),
      ),
    ]);
  }, [pinnedCollapsedThread, projectExpanded]);

  return {
    projectStatus,
    orderedProjectThreadKeys,
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    treeProject,
    visibleTreeThreadKeys,
  };
}
