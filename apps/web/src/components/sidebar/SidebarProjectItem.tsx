import { ProjectBrowserPreview } from "../../browser/ProjectBrowserPreview";
import React, { useCallback, memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type ThreadEnvMode } from "@ryco/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import { useRouter } from "@tanstack/react-router";
import { type SidebarThreadSortOrder } from "@ryco/contracts/settings";
import { isMacPlatform } from "../../lib/utils";
import {
  selectSidebarThreadsForProjectRefs,
  selectSidebarWorktreesForProjectRefs,
  useStore,
} from "../../store";
import { useUiStateStore } from "../../uiStateStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { markSidebarExpandClick } from "../../perf/tabSwitchInstrumentation";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSidebar } from "../ui/sidebar";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { isContextMenuPointerDown } from "../Sidebar.logic";
import { readLocalApi } from "../../localApi";
import { SidebarWorktreeList, type SidebarThreadGitStatusTarget } from "./SidebarWorktreeList";
import {
  createSidebarProjectDraftThreadsSelector,
  mergeSidebarThreadsWithDrafts,
} from "./sidebarTreeAdapters";
import { type SidebarTreeThread } from "./hooks/useSidebarTree";
import { type SortableProjectHandleProps } from "./SidebarProjectList";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { SidebarProjectThreadList } from "./SidebarProjectThreadList";
import { useSettings } from "~/hooks/useSettings";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarProjectHeader } from "./SidebarProjectHeader";
import { useHasIntersectedViewport } from "./hooks/useHasIntersectedViewport";
import { useSidebarProjectJiraLinks } from "./hooks/useSidebarProjectJiraLinks";
import { useSidebarProjectThreadPresentation } from "./hooks/useSidebarProjectThreadPresentation";
import { useThreadClipboardActions } from "./hooks/useThreadClipboardActions";
import { useSidebarProjectActions } from "./hooks/useSidebarProjectActions";
import { useSidebarThreadActions } from "./hooks/useSidebarThreadActions";
import { useSidebarWorktreeActions } from "./hooks/useSidebarWorktreeActions";
import { useSidebarProjectContextMenu } from "./hooks/useSidebarProjectContextMenu";
import { useSidebarProjectDialogs } from "./SidebarProjectDialogOwner";

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  onNewFolderWithProject: (project: SidebarProjectSnapshot) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
}

export const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    handleNewThread,
    archiveThread,
    deleteThread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    onNewFolderWithProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;
  const threadSortOrder = useSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const appSettingsConfirmThreadDelete = useSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const appSettingsConfirmThreadUnpin = useSettings<boolean>(
    (settings) => settings.confirmThreadUnpin,
  );
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const toggleProject = useUiStateStore((state) => state.toggleProject);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const selectedThreadCount = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { copyThreadIdToClipboard, copyPathToClipboard } = useThreadClipboardActions();
  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);
  const sidebarThreads = useStore(
    useShallow(
      useMemo(
        () => (state: import("../../store").AppState) =>
          selectSidebarThreadsForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const sidebarWorktrees = useStore(
    useShallow(
      useMemo(
        () => (state: import("../../store").AppState) =>
          selectSidebarWorktreesForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const projectDraftThreads = useComposerDraftStore(
    useMemo(() => createSidebarProjectDraftThreadsSelector(project), [project]),
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef =
    useRef<ReadonlyMap<string, SidebarThreadSummary>>(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const projectThreads = useMemo(
    () => mergeSidebarThreadsWithDrafts(sidebarThreads, projectDraftThreads),
    [projectDraftThreads, sidebarThreads],
  );
  const projectExpanded = useUiStateStore(
    (state) => state.projectExpandedById[project.projectKey] ?? true,
  );
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      projectThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const lastVisitedAtByThreadKey = useMemo(
    () =>
      new Map(
        projectThreads.map((thread, index) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          threadLastVisitedAts[index] ?? null,
        ]),
      ),
    [projectThreads, threadLastVisitedAts],
  );
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const projectDialogs = useSidebarProjectDialogs();
  const [setProjectHeaderVisibilityNode, projectHeaderHasIntersected] = useHasIntersectedViewport();
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  const resolveThreadGitStatusTarget = useCallback(
    (
      thread: Pick<
        SidebarTreeThread,
        "branch" | "environmentId" | "projectId" | "sourceProjectId" | "worktreePath"
      >,
    ): SidebarThreadGitStatusTarget | null => {
      if (thread.branch === null) {
        return null;
      }
      const sourceProjectId = thread.sourceProjectId ?? thread.projectId;
      const memberProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, sourceProjectId)),
      );
      const cwd = thread.worktreePath ?? memberProject?.cwd ?? project.cwd;
      return cwd ? { environmentId: thread.environmentId, cwd } : null;
    },
    [memberProjectByScopedKey, project.cwd],
  );
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of projectThreads) {
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) {
        continue;
      }
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, projectThreads]);

  const jiraProjectOpenUrlByProjectKey = useSidebarProjectJiraLinks({
    project,
    explorerOpen: false,
    projectVisible: projectHeaderHasIntersected,
  });

  const {
    projectStatus,
    orderedProjectThreadKeys,
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    treeProject,
    visibleTreeThreadKeys,
  } = useSidebarProjectThreadPresentation({
    project,
    projectThreads,
    sidebarWorktrees,
    lastVisitedAtByThreadKey,
    threadSortOrder,
    activeRouteThreadKey,
    projectExpanded,
    isThreadListExpanded,
  });

  const { openProjectRemoteLink, openProjectJiraLink, handleRemoveProject } =
    useSidebarProjectActions({
      memberThreadCountByPhysicalKey,
      jiraProjectOpenUrlByProjectKey,
    });

  const threadActions = useSidebarThreadActions({
    router,
    isMobile,
    setOpenMobile,
    clearSelection,
    setSelectionAnchor,
    toggleThreadSelection,
    rangeSelectTo,
    removeFromSelection,
    selectedThreadCount,
    appSettingsConfirmThreadDelete,
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    defaultThreadEnvMode,
    deleteThread,
    archiveThread,
    handleNewThread,
    markThreadUnread,
    copyPathToClipboard,
    copyThreadIdToClipboard,
    sidebarThreadByKeyRef,
    memberProjectByScopedKey,
    projectCwd: project.cwd,
  });
  const {
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingCommittedRef,
    renamingInputRef,
    navigateToThread,
    navigateToDraft,
    closeThread,
    handleThreadClick,
    handleMultiSelectContextMenu,
    createThreadForProjectMember,
    attemptArchiveThread,
    cancelRename,
    commitRename,
    handleThreadContextMenu,
  } = threadActions;

  const {
    createThreadInWorktree,
    openWorktree,
    copyWorktreePath,
    openWorktreeInEditor,
    archiveWorktree,
    deleteWorktree,
    restoreWorktree,
    renameWorktree,
  } = useSidebarWorktreeActions({
    project,
    deleteThread,
    navigateToThread,
    createThreadForProjectMember,
    copyPathToClipboard,
  });

  const openProjectOverview = useCallback(() => {
    projectDialogs.openExplorer(project, "overview");
  }, [project, projectDialogs]);

  const { handleProjectButtonContextMenu } = useSidebarProjectContextMenu({
    project,
    jiraProjectOpenUrlByProjectKey,
    suppressProjectClickForContextMenuRef,
    onOpenOverview: openProjectOverview,
    openProjectSettingsDialog: projectDialogs.openSettings,
    openProjectRemoteLink,
    openProjectJiraLink,
    openProjectRenameDialog: projectDialogs.openRename,
    openProjectGroupingDialog: projectDialogs.openGrouping,
    copyPathToClipboard,
    handleRemoveProject,
  });

  const handleProjectButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadCount > 0) {
        clearSelection();
      }
      if (!projectExpanded) {
        markSidebarExpandClick(project.projectKey);
      }
      toggleProject(project.projectKey);
    },
    [
      clearSelection,
      dragInProgressRef,
      project.projectKey,
      projectExpanded,
      selectedThreadCount,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
      toggleProject,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      if (!projectExpanded) {
        markSidebarExpandClick(project.projectKey);
      }
      toggleProject(project.projectKey);
    },
    [dragInProgressRef, project.projectKey, projectExpanded, toggleProject],
  );

  const handleProjectButtonPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
  );

  const handleOpenNewWorktreeClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      projectDialogs.openNewWorktree(project, "branches");
    },
    [project, projectDialogs],
  );

  // Routes through the ordinary new-thread path, which reuses this project's
  // existing draft when there is one and lands on `/draft/$draftId` — the
  // composer-first surface with the hero and inline worktree controls.
  const handleOpenNewThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const member = project.memberProjects[0];
      if (!member) return;
      createThreadForProjectMember(member);
    },
    [createThreadForProjectMember, project.memberProjects],
  );

  const handleOpenProjectOverviewClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      projectDialogs.openExplorer(project, "overview");
    },
    [project, projectDialogs],
  );

  return (
    <>
      <SidebarProjectHeader
        project={project}
        isManualProjectSorting={isManualProjectSorting}
        dragHandleProps={dragHandleProps}
        projectExpanded={projectExpanded}
        projectStatus={projectStatus}
        jiraProjectOpenUrlByProjectKey={jiraProjectOpenUrlByProjectKey}
        setProjectHeaderVisibilityNode={setProjectHeaderVisibilityNode}
        onPointerDownCapture={handleProjectButtonPointerDownCapture}
        onClick={handleProjectButtonClick}
        onKeyDown={handleProjectButtonKeyDown}
        onContextMenu={handleProjectButtonContextMenu}
        onOpenProjectOverviewClick={handleOpenProjectOverviewClick}
        onOpenNewWorktreeClick={handleOpenNewWorktreeClick}
        onOpenNewThreadClick={handleOpenNewThreadClick}
        onCopyPath={(member) => {
          copyPathToClipboard(member.cwd, { path: member.cwd });
        }}
        onGrouping={projectDialogs.openGrouping}
        onNewFolderWithProject={onNewFolderWithProject}
        onOpenJiraProject={openProjectJiraLink}
        onOpenOverview={openProjectOverview}
        onOpenRemote={openProjectRemoteLink}
        onRemove={(member) => {
          void handleRemoveProject(member);
        }}
        onRename={projectDialogs.openRename}
        onSettings={projectDialogs.openSettings}
      />

      {projectExpanded ? (
        <div className="pl-5 pr-2">
          <ProjectBrowserPreview environmentId={project.environmentId} cwd={project.cwd} />
        </div>
      ) : null}

      {treeProject?.isGitRepo ? (
        <SidebarWorktreeList
          treeProject={treeProject}
          projectExpanded={projectExpanded}
          visibleThreadKeys={visibleTreeThreadKeys}
          attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
          resolveThreadGitStatusTarget={resolveThreadGitStatusTarget}
          onArchiveWorktree={archiveWorktree}
          onCopyWorktreePath={copyWorktreePath}
          onDeleteWorktree={deleteWorktree}
          onNewSession={createThreadInWorktree}
          onOpenInEditor={openWorktreeInEditor}
          onOpenWorktree={openWorktree}
          onRenameWorktree={renameWorktree}
          onRestoreWorktree={restoreWorktree}
          renderThread={(thread: SidebarTreeThread, treeThreadKeys, gitStatus) => {
            const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
            return (
              <SidebarThreadRow
                key={threadKey}
                thread={thread}
                projectCwd={project.cwd}
                gitStatus={gitStatus}
                orderedProjectThreadKeys={treeThreadKeys}
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
                closeThread={closeThread}
                clearSelection={clearSelection}
                commitRename={commitRename}
                cancelRename={cancelRename}
                attemptArchiveThread={attemptArchiveThread}
                openPrLink={openPrLink}
                isTreeChild={thread.draftId === undefined}
              />
            );
          }}
        />
      ) : (
        <SidebarProjectThreadList
          projectKey={project.projectKey}
          projectExpanded={projectExpanded}
          hasOverflowingThreads={hasOverflowingThreads}
          hiddenThreadStatus={hiddenThreadStatus}
          orderedProjectThreadKeys={orderedProjectThreadKeys}
          renderedThreads={renderedThreads}
          showEmptyThreadState={showEmptyThreadState}
          shouldShowThreadPanel={shouldShowThreadPanel}
          isThreadListExpanded={isThreadListExpanded}
          projectCwd={project.cwd}
          activeRouteThreadKey={activeRouteThreadKey}
          threadJumpLabelByKey={threadJumpLabelByKey}
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
          attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
          handleThreadClick={handleThreadClick}
          navigateToThread={navigateToThread}
          navigateToDraft={navigateToDraft}
          handleMultiSelectContextMenu={handleMultiSelectContextMenu}
          handleThreadContextMenu={handleThreadContextMenu}
          closeThread={closeThread}
          clearSelection={clearSelection}
          commitRename={commitRename}
          cancelRename={cancelRename}
          attemptArchiveThread={attemptArchiveThread}
          openPrLink={openPrLink}
          expandThreadListForProject={expandThreadListForProject}
          collapseThreadListForProject={collapseThreadListForProject}
        />
      )}
    </>
  );
});
