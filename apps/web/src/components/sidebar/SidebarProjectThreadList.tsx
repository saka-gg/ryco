import React, { memo, useEffect, useMemo, useRef } from "react";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react";
import type { ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { markSidebarExpandFirstPaint } from "../../perf/tabSwitchInstrumentation";
import { type DraftId } from "../../composerDraftStore";
import type { SidebarThreadSummary } from "../../types";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { type ThreadStatusPill } from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { SidebarThreadRow } from "./SidebarThreadRow";

// Above this many rendered threads the list is windowed via LegendList (the
// same virtualization dependency as MessagesTimeline) so expanding a project
// with hundreds of threads stays cheap. Because rendered threads are capped to
// THREAD_PREVIEW_LIMIT until the user expands the list, virtualization only
// engages once a large list has been explicitly expanded.
const VIRTUALIZE_THREAD_THRESHOLD = 20;
// Approximate height of a single thread row (h-7 button + gap-0.5).
const ESTIMATED_THREAD_ROW_SIZE = 30;
// Bounds the virtualized scroll region so it owns its own scrollbar instead of
// growing the whole sidebar. Without a bounded height LegendList cannot window.
const VIRTUALIZED_LIST_MAX_HEIGHT = "min(60vh, 640px)";

export interface SidebarProjectThreadListProps {
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedProjectThreadKeys: readonly string[];
  renderedThreads: readonly SidebarThreadSummary[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  projectCwd: string;
  activeRouteThreadKey: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  navigateToDraft: (draftId: DraftId, threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  requestTrashThread: (
    thread: SidebarThreadSummary & { draftId?: DraftId | undefined },
    opts?: { deletedThreadKeys?: ReadonlySet<string> },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

function threadRowKey(thread: SidebarThreadSummary): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** Reuse the previous key-order array when the sequence is unchanged. */
function useStableOrderedThreadKeys(keys: readonly string[]): readonly string[] {
  const cacheRef = useRef<readonly string[]>(keys);
  return useMemo(() => {
    const previous = cacheRef.current;
    if (previous.length === keys.length && keys.every((key, index) => previous[index] === key)) {
      return previous;
    }
    cacheRef.current = keys;
    return keys;
  }, [keys]);
}

export const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    projectKey,
    projectExpanded,
    hasOverflowingThreads,
    hiddenThreadStatus,
    orderedProjectThreadKeys,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    projectCwd,
    activeRouteThreadKey,
    threadJumpLabelByKey,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    navigateToDraft,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    requestTrashThread,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const stableOrderedProjectThreadKeys = useStableOrderedThreadKeys(orderedProjectThreadKeys);
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);

  useEffect(() => {
    if (!projectExpanded || !shouldShowThreadPanel) {
      return;
    }
    queueMicrotask(() => markSidebarExpandFirstPaint(projectKey));
  }, [projectExpanded, projectKey, shouldShowThreadPanel]);

  const renderThreadRow = (thread: SidebarThreadSummary) => {
    const threadKey = threadRowKey(thread);
    return (
      <SidebarThreadRow
        key={threadKey}
        thread={thread}
        projectCwd={projectCwd}
        orderedProjectThreadKeys={stableOrderedProjectThreadKeys}
        isActive={activeRouteThreadKey === threadKey}
        jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        startThreadRename={startThreadRename}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        navigateToDraft={navigateToDraft}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        requestTrashThread={requestTrashThread}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
      />
    );
  };

  const showLessControl = projectExpanded && hasOverflowingThreads && isThreadListExpanded && (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={showLessButtonRender}
        data-thread-selection-safe
        size="sm"
        className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
        onClick={() => {
          collapseThreadListForProject(projectKey);
        }}
      >
        <span>Show less</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );

  // Virtualize large expanded lists. Drag-and-drop reorder is intentionally not
  // wired here: per the roadmap risk mitigation the safest option is to keep the
  // virtualized list non-reorderable (this list has never supported thread
  // reorder), so windowing can never desync a drag against off-screen rows.
  const shouldVirtualize =
    shouldShowThreadPanel && renderedThreads.length > VIRTUALIZE_THREAD_THRESHOLD;

  if (shouldVirtualize) {
    return (
      <div className="mx-1 my-0 w-full translate-x-0 overflow-hidden border-sidebar-border border-l px-1.5 py-0">
        <LegendList<SidebarThreadSummary>
          data={renderedThreads}
          keyExtractor={threadRowKey}
          estimatedItemSize={ESTIMATED_THREAD_ROW_SIZE}
          recycleItems={false}
          renderItem={({ item }: LegendListRenderItemProps<SidebarThreadSummary>) => (
            <div className="pb-0.5">{renderThreadRow(item)}</div>
          )}
          className="overscroll-y-contain [scrollbar-gutter:stable]"
          style={{ maxHeight: VIRTUALIZED_LIST_MAX_HEIGHT }}
        />
        {showLessControl ? (
          <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 gap-0 border-none px-0 py-0">
            {showLessControl}
          </SidebarMenuSub>
        ) : null}
      </div>
    );
  }

  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel && renderedThreads.map((thread) => renderThreadRow(thread))}

      {projectExpanded && hasOverflowingThreads && !isThreadListExpanded && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            data-thread-selection-safe
            size="sm"
            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
            onClick={() => {
              expandThreadListForProject(projectKey);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
              <span>Show more</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
      {showLessControl}
    </SidebarMenuSub>
  );
});
