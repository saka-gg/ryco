import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ProjectId } from "@ryco/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  FolderIcon,
  GitBranchIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";

import { useCommandPaletteStore } from "../../../commandPaletteStore";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../../environments/runtime";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { getProjectOrderKey } from "../../../logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { buildSidebarProjectFolderTree } from "../../../sidebarProjectFolders";
import { useSettingsDialogStore } from "../../../settingsDialogStore";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRefs,
  selectSidebarWorktreesForProjectRefs,
  useStore,
  type AppState,
} from "../../../store";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { useUiStateStore } from "../../../uiStateStore";
import { cn } from "~/lib/utils";
import { useLongPress } from "~/hooks/useLongPress";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import {
  orderItemsByPreferredIds,
  resolveSidebarNewThreadEnvMode,
  sortProjectsForSidebar,
  sortThreadsWithPinned,
} from "../../Sidebar.logic";
import {
  adaptProjectForSidebarTree,
  createSidebarProjectDraftThreadsSelector,
  mergeSidebarThreadsWithDrafts,
} from "../../sidebar/sidebarTreeAdapters";
import {
  useSidebarTree,
  type SidebarTreeThread,
  type SidebarTreeWorktree,
} from "../../sidebar/hooks/useSidebarTree";
import { useSidebarProjectActions } from "../../sidebar/hooks/useSidebarProjectActions";
import { useSidebarProjectContextMenu } from "../../sidebar/hooks/useSidebarProjectContextMenu";
import { useSidebarProjectGroupingDialog } from "../../sidebar/hooks/useSidebarProjectGroupingDialog";
import { useSidebarProjectRenameDialog } from "../../sidebar/hooks/useSidebarProjectRenameDialog";
import { useSidebarProjectSettingsDialog } from "../../sidebar/hooks/useSidebarProjectSettingsDialog";
import { useThreadClipboardActions } from "../../sidebar/hooks/useThreadClipboardActions";
import { ProjectExplorerDialog } from "../../projectExplorer/ProjectExplorerDialog";
import { ProjectSettingsDialog } from "../../sidebar/ProjectSettingsDialog";
import { SidebarProjectGroupingDialog } from "../../sidebar/SidebarProjectGroupingDialog";
import { SidebarProjectRenameDialog } from "../../sidebar/SidebarProjectRenameDialog";
import { HostedConnectionPill } from "../../hostedHub/HostedConnectionControls";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadStatusDetailLine,
} from "../../ThreadStatusIndicators";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { SidebarInset } from "../../ui/sidebar";
import { MobileDock } from "../../mobile/MobileDock";
import { MobileListRow } from "../../mobile/MobileListRow";
import {
  MobileSheet,
  MobileSheetDescription,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../../mobile/MobileSheet";
import { PhoneThreadActionsSheet, PhoneThreadRenameDialog } from "./PhoneThreadActionsSheet";
import { usePhoneThreadActions } from "./usePhoneThreadActions";

// Jira project links are resolved by the desktop explorer visibility
// machinery; the phone project menu omits the "Open Jira project" entry
// rather than porting that fetch pipeline.
const EMPTY_JIRA_PROJECT_LINKS: ReadonlyMap<string, string> = new Map();

/**
 * Phone Home ("Threads"): the first-class phone route at the logical root — a
 * project-grouped thread list rendered from exactly the stores and selectors
 * the desktop sidebar consumes (projects, threads, drafts, uiState ordering,
 * pinning, and sort-order settings), so a hosted node switch resets both
 * presentations through the same store resets.
 */
export function PhoneHome() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectFoldersById = useUiStateStore((store) => store.projectFoldersById);
  const projectFolderOrder = useUiStateStore((store) => store.projectFolderOrder);
  const projectTreeOrder = useUiStateStore((store) => store.projectTreeOrder);
  const setProjectFolderExpanded = useUiStateStore((store) => store.setProjectFolderExpanded);
  const sidebarProjectSortOrder = useSettings((s) => s.sidebarProjectSortOrder);
  const defaultThreadEnvMode = useSettings((s) => s.defaultThreadEnvMode);
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const openCommandPalette = useCommandPaletteStore((store) => store.setOpen);
  const { handleNewThread } = useNewThreadHandler();
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
      }),
    [projectOrder, projects],
  );
  const physicalToLogicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects: orderedProjects,
        settings: projectGroupingSettings,
      }),
    [orderedProjects, projectGroupingSettings],
  );
  const sidebarProjects = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => {
          const rt = savedEnvironmentRuntimeById[environmentId];
          const saved = savedEnvironmentRegistry[environmentId];
          return rt?.descriptor?.label ?? saved?.label ?? null;
        },
      }),
    [
      orderedProjects,
      projectGroupingSettings,
      primaryEnvironmentId,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
    ],
  );
  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) =>
      Object.assign({}, project, { id: project.projectKey as ProjectId }),
    );
    const sortableThreads = sidebarThreads
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => {
        const physicalKey = scopedProjectKey(
          scopeProjectRef(thread.environmentId, thread.projectId),
        );
        return Object.assign({}, thread, {
          projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
        });
      });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    physicalToLogicalKey,
    sidebarProjectByKey,
    sidebarProjectSortOrder,
    sidebarProjects,
    sidebarThreads,
  ]);
  const projectTreeRows = useMemo(
    () =>
      buildSidebarProjectFolderTree({
        projects: sortedProjects,
        projectFoldersById,
        projectFolderOrder,
        projectTreeOrder,
        projectSortOrder: sidebarProjectSortOrder,
      }),
    [
      projectFolderOrder,
      projectFoldersById,
      projectTreeOrder,
      sidebarProjectSortOrder,
      sortedProjects,
    ],
  );

  const startThreadInProject = (project: SidebarProjectSnapshot) => {
    const member = project.memberProjects[0];
    if (!member) return;
    setProjectPickerOpen(false);
    void handleNewThread(scopeProjectRef(member.environmentId, member.id), {
      envMode: resolveSidebarNewThreadEnvMode({ defaultEnvMode: defaultThreadEnvMode }),
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* The app bar is title plus the connection indicator. Search, New
            thread and settings were the three controls stranded in the
            top-right corner; they are in the dock now. */}
        <header className="flex items-center gap-1.5 border-b border-border pr-[calc(env(safe-area-inset-right)+0.5rem)] pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Threads</h1>
          <HostedConnectionPill />
        </header>
        <div
          data-testid="phone-home-list"
          // The list takes the full height the app bar used to waste, and the
          // dock is an overlay, so the bottom scroll padding — not a layout
          // reservation — is what lets the last row clear the capsule.
          className="app-dock-scroll-clearance flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {projectTreeRows.length === 0 ? (
            // Centred in the content region rather than pinned under the app
            // bar, now that the region is the whole screen.
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle className="text-base">No projects yet</EmptyTitle>
                <EmptyDescription className="mt-1 text-sm">
                  Projects opened on this node appear here with their threads.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            projectTreeRows.map((row) =>
              row.kind === "project" ? (
                <PhoneHomeProjectSection key={row.itemId} project={row.project} />
              ) : (
                <section key={row.itemId} aria-label={row.folder.name}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium text-muted-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-expanded={row.folder.expanded}
                    onClick={() => setProjectFolderExpanded(row.folder.id, !row.folder.expanded)}
                  >
                    {row.folder.expanded ? (
                      <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                    ) : (
                      <ChevronRightIcon aria-hidden className="size-4 shrink-0" />
                    )}
                    <FolderIcon aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{row.folder.name}</span>
                  </button>
                  {row.folder.expanded
                    ? row.projects.map((project) => (
                        <PhoneHomeProjectSection
                          key={project.projectKey}
                          project={project}
                          nested
                        />
                      ))
                    : null}
                </section>
              ),
            )
          )}
        </div>
      </div>
      <MobileDock
        label="Home actions"
        actions={[
          {
            id: "search",
            label: "Search threads",
            shortLabel: "Search",
            icon: <SearchIcon aria-hidden className="size-4 shrink-0" />,
            onSelect: () => openCommandPalette(true),
          },
          {
            id: "new-thread",
            label: "New thread",
            icon: <PlusIcon aria-hidden className="size-4 shrink-0" />,
            disabled: sortedProjects.length === 0,
            onSelect: () => {
              if (sortedProjects.length === 1 && sortedProjects[0]) {
                startThreadInProject(sortedProjects[0]);
                return;
              }
              setProjectPickerOpen(true);
            },
          },
          {
            id: "settings",
            label: "Open settings",
            shortLabel: "Settings",
            icon: <SettingsIcon aria-hidden className="size-4 shrink-0" />,
            onSelect: () => openSettings(),
          },
        ]}
      />
      <MobileSheet open={projectPickerOpen} onOpenChange={setProjectPickerOpen} label="New thread">
        <MobileSheetHeader>
          <MobileSheetTitle>New thread</MobileSheetTitle>
          <MobileSheetDescription>Choose a project for the new thread.</MobileSheetDescription>
        </MobileSheetHeader>
        <MobileSheetPanel>
          <div role="group" aria-label="Projects" className="space-y-0.5">
            {sortedProjects.map((project) => (
              <MobileListRow
                key={project.projectKey}
                label={project.displayName}
                onClick={() => startThreadInProject(project)}
              />
            ))}
          </div>
        </MobileSheetPanel>
      </MobileSheet>
    </SidebarInset>
  );
}

function PhoneHomeProjectSection({
  project,
  nested = false,
}: {
  readonly project: SidebarProjectSnapshot;
  readonly nested?: boolean;
}) {
  const threads = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          selectSidebarThreadsForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const draftThreads = useComposerDraftStore(
    useMemo(() => createSidebarProjectDraftThreadsSelector(project), [project]),
  );
  const threadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const pinnedThreadKeysRecord = useUiStateStore((store) => store.pinnedThreadKeys);
  const expanded = useUiStateStore(
    (store) => store.projectExpandedById[project.projectKey] ?? true,
  );
  const toggleProject = useUiStateStore((store) => store.toggleProject);

  const pinnedThreadKeys = useMemo(
    () =>
      new Set(
        Object.entries(pinnedThreadKeysRecord).flatMap(([threadKey, pinned]) =>
          pinned ? [threadKey] : [],
        ),
      ),
    [pinnedThreadKeysRecord],
  );
  const visibleThreads = useMemo(() => {
    return mergeSidebarThreadsWithDrafts(threads, draftThreads).filter(
      (thread) => thread.archivedAt === null,
    );
  }, [draftThreads, threads]);
  const sortedThreads = useMemo(
    () =>
      sortThreadsWithPinned({
        threads: visibleThreads,
        sortOrder: threadSortOrder,
        pinnedThreadKeys,
        getThreadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      }),
    [pinnedThreadKeys, threadSortOrder, visibleThreads],
  );
  const threadByKey = useMemo(
    () =>
      new Map(
        sortedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sortedThreads],
  );
  const threadByKeyRef = useRef<ReadonlyMap<string, SidebarTreeThread>>(threadByKey);
  threadByKeyRef.current = threadByKey;
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
  const threadActions = usePhoneThreadActions({
    sidebarThreadByKeyRef: threadByKeyRef,
    memberProjectByScopedKey,
    projectCwd: project.cwd ?? null,
  });
  const [menuThreadKey, setMenuThreadKey] = useState<string | null>(null);
  const menuThread = menuThreadKey ? (threadByKey.get(menuThreadKey) ?? null) : null;
  const renamingThread = threadActions.renamingThreadKey
    ? (threadByKey.get(threadActions.renamingThreadKey) ?? null)
    : null;

  // The same worktree tree the desktop sidebar composes (adapters unchanged):
  // projects with more than one worktree layer their sessions into
  // collapsed-by-default worktree sections; simple projects keep the flat
  // list.
  const worktreeSummaries = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          selectSidebarWorktreesForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const sidebarTreeInput = useMemo(
    () =>
      adaptProjectForSidebarTree({
        project,
        threads: sortedThreads,
        worktrees: worktreeSummaries,
      }),
    [project, sortedThreads, worktreeSummaries],
  );
  const sidebarTree = useSidebarTree({
    projects: [sidebarTreeInput.project],
    threads: sidebarTreeInput.threads,
    worktrees: sidebarTreeInput.worktrees,
  });
  const treeProject = sidebarTree.projects[0] ?? null;
  const worktreeSections =
    treeProject && treeProject.isGitRepo && treeProject.worktrees.length > 1
      ? treeProject.worktrees
      : null;

  // Project-management actions (issue criterion: no right-click-only
  // actions on phone): the header kebab and a header long-press present the
  // EXISTING desktop project context-menu inventory through the shared
  // action sheet, reusing the desktop dialogs and handlers unchanged.
  const { updateSettings } = useUpdateSettings();
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const { copyPathToClipboard } = useThreadClipboardActions();
  const [explorerDialogOpen, setExplorerDialogOpen] = useState(false);
  const settingsDialog = useSidebarProjectSettingsDialog();
  const renameDialog = useSidebarProjectRenameDialog();
  const groupingDialog = useSidebarProjectGroupingDialog({
    projectGroupingSettings,
    updateSettings,
  });
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of threads) {
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) continue;
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, threads]);
  const { openProjectRemoteLink, openProjectJiraLink, handleRemoveProject } =
    useSidebarProjectActions({
      memberThreadCountByPhysicalKey,
      jiraProjectOpenUrlByProjectKey: EMPTY_JIRA_PROJECT_LINKS,
    });
  const suppressProjectClickForContextMenuRef = useRef(false);
  const openProjectOverview = useCallback(() => {
    setExplorerDialogOpen(true);
  }, []);
  const { openProjectMenu } = useSidebarProjectContextMenu({
    project,
    jiraProjectOpenUrlByProjectKey: EMPTY_JIRA_PROJECT_LINKS,
    suppressProjectClickForContextMenuRef,
    onOpenOverview: openProjectOverview,
    openProjectSettingsDialog: settingsDialog.openProjectSettingsDialog,
    openProjectRemoteLink,
    openProjectJiraLink,
    openProjectRenameDialog: renameDialog.openProjectRenameDialog,
    openProjectGroupingDialog: groupingDialog.openProjectGroupingDialog,
    copyPathToClipboard,
    handleRemoveProject,
  });
  const projectLongPress = useLongPress((point) => openProjectMenu(point));

  const renderThreadRow = (thread: SidebarTreeThread) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return (
      <PhoneHomeThreadRow
        key={threadKey}
        thread={thread}
        pinned={pinnedThreadKeys.has(threadKey)}
        onOpen={() => {
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);
          if (thread.draftId) {
            threadActions.navigateToDraft(thread.draftId, threadRef);
            return;
          }
          threadActions.navigateToThread(threadRef);
        }}
        onMenu={() => setMenuThreadKey(threadKey)}
      />
    );
  };

  return (
    <section aria-label={project.displayName} className={cn(nested && "pl-3")}>
      <div className="flex items-stretch">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-accent/40"
          aria-expanded={expanded}
          onClick={() => toggleProject(project.projectKey)}
          {...projectLongPress}
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.displayName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{sortedThreads.length}</span>
        </button>
        <button
          type="button"
          aria-label={`Project actions for ${project.displayName}`}
          className="flex w-11 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={(event) => openProjectMenu({ x: event.clientX, y: event.clientY })}
        >
          <EllipsisVerticalIcon aria-hidden className="size-4" />
        </button>
      </div>
      {expanded ? (
        worktreeSections ? (
          <div className="pl-3">
            {worktreeSections.map((worktreeNode) => (
              <PhoneHomeWorktreeSection
                key={worktreeNode.worktree.worktreeId}
                worktreeNode={worktreeNode}
                renderThreadRow={renderThreadRow}
              />
            ))}
          </div>
        ) : (
          <div role="list" aria-label={`Threads in ${project.displayName}`}>
            {sortedThreads.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-muted-foreground">No threads yet.</p>
            ) : (
              sortedThreads.map((thread) => renderThreadRow(thread))
            )}
          </div>
        )
      ) : null}
      <PhoneThreadActionsSheet
        open={menuThread !== null}
        onOpenChange={(open) => {
          if (!open) setMenuThreadKey(null);
        }}
        title={menuThread?.title ?? "Thread"}
        items={menuThreadKey ? threadActions.listThreadMenuActions(menuThreadKey) : []}
        leadingSections={menuThread ? <ThreadStatusDetailLine thread={menuThread} /> : undefined}
        onAction={(actionId) => {
          const threadRef = menuThreadKey ? parseScopedThreadKey(menuThreadKey) : null;
          setMenuThreadKey(null);
          if (!threadRef) return;
          void threadActions.performThreadMenuAction(threadRef, actionId);
        }}
      />
      <PhoneThreadRenameDialog
        renamingThreadKey={threadActions.renamingThreadKey}
        originalTitle={renamingThread?.title ?? ""}
        renamingTitle={threadActions.renamingTitle}
        setRenamingTitle={threadActions.setRenamingTitle}
        commitRename={threadActions.commitRename}
        cancelRename={threadActions.cancelRename}
      />
      {/* The desktop project dialogs, reused unchanged behind the phone
          project menu. They render nothing while closed. */}
      <ProjectExplorerDialog
        open={explorerDialogOpen}
        projectName={project.displayName}
        memberProjects={project.memberProjects}
        initialTab="overview"
        onOpenChange={setExplorerDialogOpen}
      />
      <ProjectSettingsDialog
        open={settingsDialog.projectSettingsOpen}
        target={settingsDialog.projectSettingsTarget}
        title={settingsDialog.projectSettingsTitle}
        customAvatarContentHash={settingsDialog.projectSettingsCustomAvatarContentHash}
        projectAvatarUploadUnavailableReason={settingsDialog.projectAvatarUploadUnavailableReason}
        preferredRemoteName={settingsDialog.projectSettingsPreferredRemoteName}
        workspaceRoot={settingsDialog.projectSettingsWorkspaceRoot}
        customSystemPrompt={settingsDialog.projectSettingsCustomSystemPrompt}
        saving={settingsDialog.projectSettingsSaving}
        onClose={settingsDialog.closeProjectSettingsDialog}
        onSave={() => void settingsDialog.submitProjectSettings()}
        onTitleChange={settingsDialog.setProjectSettingsTitle}
        onWorkspaceRootChange={settingsDialog.setProjectSettingsWorkspaceRoot}
        onCustomSystemPromptChange={settingsDialog.setProjectSettingsCustomSystemPrompt}
        onPreferredRemoteChange={settingsDialog.setProjectSettingsPreferredRemoteName}
        onPickWorkspaceRoot={() => void settingsDialog.pickProjectSettingsWorkspaceRoot()}
        onOpenRemote={settingsDialog.openProjectRemoteByName}
        onUploadAvatar={settingsDialog.uploadProjectAvatar}
        onRemoveAvatar={settingsDialog.removeProjectAvatar}
      />
      <SidebarProjectRenameDialog
        target={renameDialog.projectRenameTarget}
        title={renameDialog.projectRenameTitle}
        onTitleChange={renameDialog.setProjectRenameTitle}
        onClose={renameDialog.closeProjectRenameDialog}
        onSubmit={() => void renameDialog.submitProjectRename()}
      />
      <SidebarProjectGroupingDialog
        target={groupingDialog.projectGroupingTarget}
        selection={groupingDialog.projectGroupingSelection}
        globalGroupingMode={projectGroupingSettings.sidebarProjectGroupingMode}
        onSelectionChange={groupingDialog.setProjectGroupingSelection}
        onClose={groupingDialog.closeProjectGroupingDialog}
        onSave={groupingDialog.saveProjectGroupingPreference}
      />
    </section>
  );
}

/**
 * A worktree section inside a phone Home project group, mirroring the
 * desktop sidebar's worktree rows: collapsed by default, expand/collapse by
 * tap or keyboard, sessions listed inside in the shared tree order.
 */
function PhoneHomeWorktreeSection({
  worktreeNode,
  renderThreadRow,
}: {
  readonly worktreeNode: SidebarTreeWorktree;
  readonly renderThreadRow: (thread: SidebarTreeThread) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const title = worktreeNode.worktree.title ?? worktreeNode.worktree.branch;
  return (
    <section aria-label={title}>
      <button
        type="button"
        aria-expanded={!collapsed}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-muted-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => setCollapsed((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setCollapsed(true);
            return;
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setCollapsed(false);
          }
        }}
      >
        {collapsed ? (
          <ChevronRightIcon aria-hidden className="size-4 shrink-0" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
        )}
        <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-xs">{worktreeNode.sessions.length}</span>
      </button>
      {collapsed ? null : (
        <div role="list" aria-label={`Sessions in ${title}`}>
          {worktreeNode.sessions.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            worktreeNode.sessions.map((thread) => renderThreadRow(thread))
          )}
        </div>
      )}
    </section>
  );
}

function PhoneHomeThreadRow({
  thread,
  pinned,
  onOpen,
  onMenu,
}: {
  readonly thread: SidebarTreeThread;
  readonly pinned: boolean;
  readonly onOpen: () => void;
  readonly onMenu: () => void;
}) {
  const timestamp =
    thread.latestTurn?.completedAt ?? thread.latestUserMessageAt ?? thread.createdAt;
  // Long-press mirrors the kebab: it opens the same thread action sheet
  // without hijacking scroll (a >10px drag cancels) or text selection.
  const longPress = useLongPress(() => onMenu());
  return (
    <div role="listitem" className="flex items-stretch">
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
        {...longPress}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1 text-sm">
            {pinned ? (
              <PinIcon
                aria-label="Pinned"
                role="img"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
            <span className="min-w-0 truncate">{thread.title}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <ThreadRowLeadingStatus thread={thread} alwaysShowStatusLabel />
            <ThreadRowTrailingStatus thread={thread} />
          </span>
        </span>
        {timestamp ? (
          <span className="shrink-0 pr-1 text-[10px] text-muted-foreground">
            {formatRelativeTimeLabel(timestamp)}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Thread actions for ${thread.title}`}
        className="flex w-11 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onMenu}
      >
        <EllipsisVerticalIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
