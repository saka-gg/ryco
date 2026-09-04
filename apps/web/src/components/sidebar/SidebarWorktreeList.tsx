import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  ChevronRightIcon,
  CopyIcon,
  Edit3Icon,
  ExternalLinkIcon,
  FolderRootIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { cn } from "../../lib/utils";
import type { GitStatusTarget } from "../../lib/gitStatusState";
import {
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuSub, SidebarMenuSubItem } from "../ui/sidebar";
import { SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME, type SidebarStatusBucket } from "../Sidebar.logic";
import {
  isSyntheticWorktreeId,
  normalizeWorktreePath,
  type SidebarTreeProject,
  type SidebarTreeThread,
  type SidebarTreeWorktree,
  type SidebarWorktree,
} from "./hooks/useSidebarTree";
import {
  resolveSidebarStatusTextClassName,
  resolveSidebarStatusTextStyle,
} from "./sidebarStatusText";
import {
  LinkedWorktreeItemDialog,
  type LinkedWorktreeItem,
} from "../worktrees/LinkedWorktreeItemDialog";
import { WorktreeSourceControlBadges } from "../worktrees/WorktreeSourceControlBadges";

const WORKTREE_STATUS_LABELS: Record<SidebarStatusBucket, string> = {
  done: "Done",
  idle: "Idle",
  in_progress: "In progress",
  review: "Review",
};
const WORKTREE_TITLE_CLICK_TOGGLE_DELAY_MS = 180;
// An expanded worktree previews at most this many sessions; the rest hide behind
// a "Show more" toggle so a worktree with a long session history stays compact.
const WORKTREE_THREAD_PREVIEW_LIMIT = 5;

export interface SidebarWorktreeListProps {
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectExpanded: boolean;
  resolveThreadGitStatusTarget: (thread: SidebarTreeThread) => SidebarThreadGitStatusTarget | null;
  renderThread: (
    thread: SidebarTreeThread,
    orderedProjectThreadKeys: readonly string[],
    gitStatusTarget: GitStatusTarget | null | undefined,
  ) => React.ReactNode;
  treeProject: SidebarTreeProject;
  visibleThreadKeys: ReadonlySet<string> | null;
  onArchiveWorktree: (worktree: SidebarTreeWorktree) => void;
  onCopyWorktreePath: (worktree: SidebarTreeWorktree) => void;
  onDeleteWorktree: (worktree: SidebarTreeWorktree) => void;
  onNewSession: (worktree: SidebarTreeWorktree) => void;
  onOpenInEditor: (worktree: SidebarTreeWorktree) => void;
  onOpenWorktree: (worktree: SidebarTreeWorktree) => void;
  onRenameWorktree: (worktree: SidebarTreeWorktree, title: string) => Promise<void> | void;
  onRestoreWorktree: (worktree: SidebarTreeWorktree) => void;
}

export type SidebarThreadGitStatusTarget = GitStatusTarget & {
  environmentId: EnvironmentId;
  cwd: string;
};

interface LinkedWorktreeItemContext {
  cwd: string;
  environmentId: EnvironmentId;
  item: LinkedWorktreeItem;
  projectId: ProjectId;
}

export const SidebarWorktreeList = memo(function SidebarWorktreeList(
  props: SidebarWorktreeListProps,
) {
  const orderedProjectThreadKeys = useMemo(
    () => getOrderedThreadKeys(props.treeProject, props.visibleThreadKeys),
    [props.treeProject, props.visibleThreadKeys],
  );
  const visibleDraftSessions = useMemo(
    () =>
      props.treeProject.draftSessions.filter((thread) =>
        shouldRenderThread(thread, props.visibleThreadKeys),
      ),
    [props.treeProject.draftSessions, props.visibleThreadKeys],
  );
  const visibleWorktrees = useMemo(
    () =>
      props.treeProject.worktrees.filter((worktree) => {
        if (props.projectExpanded) {
          return true;
        }
        return getVisibleThreadsForWorktree(worktree, props.visibleThreadKeys).length > 0;
      }),
    [props.projectExpanded, props.treeProject.worktrees, props.visibleThreadKeys],
  );
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [linkedItemContext, setLinkedItemContext] = useState<LinkedWorktreeItemContext | null>(
    null,
  );

  const handleOpenLinkedItem = useCallback(
    (worktree: SidebarTreeWorktree, item: LinkedWorktreeItem) => {
      setLinkedItemContext({
        item,
        environmentId: resolveWorktreeEnvironmentId(worktree, props.treeProject),
        projectId: resolveWorktreeProjectId(worktree, props.treeProject),
        cwd: resolveWorktreeProjectCwd(worktree, props.treeProject),
      });
    },
    [props.treeProject],
  );
  const handleLinkedItemDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setLinkedItemContext(null);
    }
  }, []);

  if (
    visibleDraftSessions.length === 0 &&
    visibleWorktrees.length === 0 &&
    props.treeProject.archivedWorktrees.length === 0
  ) {
    return null;
  }

  return (
    <>
      <SidebarMenuSub
        ref={props.attachThreadListAutoAnimateRef}
        className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
      >
        {visibleDraftSessions.map((thread) => (
          <Fragment key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}>
            {props.renderThread(thread, orderedProjectThreadKeys, undefined)}
          </Fragment>
        ))}
        {visibleWorktrees.map((worktree) => (
          <SidebarWorktreeSection
            key={worktree.worktree.worktreeId}
            orderedProjectThreadKeys={orderedProjectThreadKeys}
            projectCwd={resolveWorktreeProjectCwd(worktree, props.treeProject)}
            projectExpanded={props.projectExpanded}
            renderThread={props.renderThread}
            resolveThreadGitStatusTarget={props.resolveThreadGitStatusTarget}
            visibleThreadKeys={props.visibleThreadKeys}
            worktree={worktree}
            onArchiveWorktree={props.onArchiveWorktree}
            onCopyWorktreePath={props.onCopyWorktreePath}
            onDeleteWorktree={props.onDeleteWorktree}
            onNewSession={props.onNewSession}
            onOpenInEditor={props.onOpenInEditor}
            onOpenLinkedItem={(item) => handleOpenLinkedItem(worktree, item)}
            onOpenWorktree={props.onOpenWorktree}
            onRenameWorktree={props.onRenameWorktree}
          />
        ))}
        {props.treeProject.archivedWorktrees.length > 0 ? (
          <>
            <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
              <button
                type="button"
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setArchivedOpen((open) => !open)}
              >
                <ChevronRightIcon className={archivedOpen ? "size-3 rotate-90" : "size-3"} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  Archived ({props.treeProject.archivedWorktrees.length})
                </span>
              </button>
            </SidebarMenuSubItem>
            {archivedOpen
              ? props.treeProject.archivedWorktrees.map((worktree) => (
                  <ArchivedWorktreeRow
                    key={worktree.worktree.worktreeId}
                    projectCwd={resolveWorktreeProjectCwd(worktree, props.treeProject)}
                    worktree={worktree}
                    onDeleteWorktree={props.onDeleteWorktree}
                    onOpenLinkedItem={(item) => handleOpenLinkedItem(worktree, item)}
                    onRestoreWorktree={props.onRestoreWorktree}
                  />
                ))
              : null}
          </>
        ) : null}
      </SidebarMenuSub>
      <LinkedWorktreeItemDialog
        open={linkedItemContext !== null}
        item={linkedItemContext?.item ?? null}
        environmentId={linkedItemContext?.environmentId ?? null}
        projectId={linkedItemContext?.projectId ?? null}
        cwd={linkedItemContext?.cwd ?? null}
        onOpenChange={handleLinkedItemDialogOpenChange}
      />
    </>
  );
});

function resolveWorktreeEnvironmentId(
  worktree: SidebarTreeWorktree,
  treeProject: SidebarTreeProject,
): EnvironmentId {
  return worktree.worktree.environmentId
    ? EnvironmentId.make(worktree.worktree.environmentId)
    : treeProject.project.environmentId;
}

function resolveWorktreeProjectId(
  worktree: SidebarTreeWorktree,
  treeProject: SidebarTreeProject,
): ProjectId {
  return worktree.worktree.sourceProjectId
    ? ProjectId.make(worktree.worktree.sourceProjectId)
    : treeProject.project.id;
}

function resolveWorktreeProjectCwd(
  worktree: SidebarTreeWorktree,
  treeProject: SidebarTreeProject,
): string {
  return worktree.worktree.sourceProjectCwd ?? treeProject.project.cwd;
}

function ArchivedWorktreeRow(props: {
  projectCwd: string;
  worktree: SidebarTreeWorktree;
  onDeleteWorktree: (worktree: SidebarTreeWorktree) => void;
  onOpenLinkedItem: (item: LinkedWorktreeItem) => void;
  onRestoreWorktree: (worktree: SidebarTreeWorktree) => void;
}) {
  const canManage = canManageWorktree(props.worktree.worktree, props.projectCwd);
  return (
    <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
      <div className="ml-3 flex h-7 phone:pointer-coarse:min-h-11 items-center gap-1.5 phone:pointer-coarse:gap-3 rounded-md px-2 text-muted-foreground">
        <ArchiveIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs">
          {getWorktreeDisplayTitle(props.worktree)}
        </span>
        <WorktreeSourceControlBadges
          issueNumber={props.worktree.worktree.issueNumber}
          issueState={props.worktree.worktree.issueState}
          prNumber={props.worktree.worktree.prNumber}
          prState={props.worktree.worktree.prState}
          prIsDraft={props.worktree.worktree.prIsDraft}
          workItemProvider={props.worktree.worktree.workItemProvider}
          workItemKey={props.worktree.worktree.workItemKey}
          workItemState={props.worktree.worktree.workItemState}
          workItemStateName={props.worktree.worktree.workItemStateName}
          displayMode="prefer-pr"
          onOpenLinkedItem={props.onOpenLinkedItem}
        />
        <button
          type="button"
          className={`inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary hover:text-foreground ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
          aria-label={`Restore ${props.worktree.worktree.branch}`}
          onClick={() => props.onRestoreWorktree(props.worktree)}
        >
          <RotateCcwIcon className="size-3.5" />
        </button>
        {canManage ? (
          <button
            type="button"
            className={`inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary hover:text-destructive ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
            aria-label={`Delete ${props.worktree.worktree.branch}`}
            onClick={() => props.onDeleteWorktree(props.worktree)}
          >
            <Trash2Icon className="size-3.5" />
          </button>
        ) : null}
      </div>
    </SidebarMenuSubItem>
  );
}

const SidebarWorktreeSection = memo(function SidebarWorktreeSection(props: {
  orderedProjectThreadKeys: readonly string[];
  projectCwd: string;
  projectExpanded: boolean;
  renderThread: (
    thread: SidebarTreeThread,
    orderedProjectThreadKeys: readonly string[],
    gitStatusTarget: GitStatusTarget | null | undefined,
  ) => React.ReactNode;
  resolveThreadGitStatusTarget: (thread: SidebarTreeThread) => SidebarThreadGitStatusTarget | null;
  visibleThreadKeys: ReadonlySet<string> | null;
  worktree: SidebarTreeWorktree;
  onArchiveWorktree: (worktree: SidebarTreeWorktree) => void;
  onCopyWorktreePath: (worktree: SidebarTreeWorktree) => void;
  onDeleteWorktree: (worktree: SidebarTreeWorktree) => void;
  onNewSession: (worktree: SidebarTreeWorktree) => void;
  onOpenInEditor: (worktree: SidebarTreeWorktree) => void;
  onOpenLinkedItem: (item: LinkedWorktreeItem) => void;
  onOpenWorktree: (worktree: SidebarTreeWorktree) => void;
  onRenameWorktree: (worktree: SidebarTreeWorktree, title: string) => Promise<void> | void;
}) {
  const isProjectRoot = isProjectRootWorktree(props.worktree.worktree, props.projectCwd);
  const canManage = canManageWorktree(props.worktree.worktree, props.projectCwd);
  const visibleThreads = useMemo(
    () =>
      props.worktree.sessions.filter((thread) =>
        shouldRenderThread(thread, props.visibleThreadKeys),
      ),
    [props.visibleThreadKeys, props.worktree.sessions],
  );
  const [collapsed, setCollapsed] = useState(true);
  const [threadsExpanded, setThreadsExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState(() => getWorktreeDisplayTitle(props.worktree));
  const pendingTitleClickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCollapsed = props.visibleThreadKeys ? false : collapsed;
  const showEmptyState = props.projectExpanded && !isCollapsed && visibleThreads.length === 0;
  const showSessions = !isCollapsed;
  // Don't cap while a thread filter is active — every match should stay visible.
  const hasOverflowingThreads =
    props.visibleThreadKeys === null && visibleThreads.length > WORKTREE_THREAD_PREVIEW_LIMIT;
  const renderedThreads = useMemo(
    () =>
      hasOverflowingThreads && !threadsExpanded
        ? visibleThreads.slice(0, WORKTREE_THREAD_PREVIEW_LIMIT)
        : visibleThreads,
    [hasOverflowingThreads, threadsExpanded, visibleThreads],
  );
  const toggleCollapsed = useCallback(() => setCollapsed((open) => !open), []);
  const clearPendingTitleClick = useCallback(() => {
    if (pendingTitleClickRef.current === null) {
      return;
    }
    clearTimeout(pendingTitleClickRef.current);
    pendingTitleClickRef.current = null;
  }, []);
  useEffect(() => clearPendingTitleClick, [clearPendingTitleClick]);
  const displayTitle = getWorktreeDisplayTitle(props.worktree);
  const statusTextStyle = useMemo(
    () =>
      props.worktree.aggregateStatus === "idle"
        ? undefined
        : resolveSidebarStatusTextStyle(displayTitle),
    [displayTitle, props.worktree.aggregateStatus],
  );
  const startRename = () => {
    clearPendingTitleClick();
    setRenameTitle(displayTitle);
    setRenaming(true);
  };
  const cancelRename = () => {
    setRenameTitle(displayTitle);
    setRenaming(false);
  };
  const commitRename = () => {
    const trimmed = renameTitle.trim();
    if (trimmed.length === 0 || trimmed === displayTitle) {
      cancelRename();
      return;
    }
    void Promise.resolve(props.onRenameWorktree(props.worktree, trimmed)).finally(() => {
      setRenaming(false);
    });
  };
  const handleTitleClick = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.stopPropagation();
      clearPendingTitleClick();
      if (event.detail > 1) {
        return;
      }
      pendingTitleClickRef.current = setTimeout(() => {
        pendingTitleClickRef.current = null;
        toggleCollapsed();
      }, WORKTREE_TITLE_CLICK_TOGGLE_DELAY_MS);
    },
    [clearPendingTitleClick, toggleCollapsed],
  );

  return (
    <>
      <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                className="group/worktree flex h-7 phone:pointer-coarse:min-h-11 w-full items-center gap-1.5 phone:pointer-coarse:gap-3 rounded-md px-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onClick={toggleCollapsed}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    setCollapsed(true);
                    return;
                  }
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    setCollapsed(false);
                    return;
                  }
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  toggleCollapsed();
                }}
              />
            }
          >
            <button
              type="button"
              aria-label={
                isCollapsed
                  ? `Expand ${props.worktree.worktree.branch}`
                  : `Collapse ${props.worktree.worktree.branch}`
              }
              className={`-ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleCollapsed();
              }}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  isCollapsed ? "" : "rotate-90",
                )}
              />
            </button>
            {isProjectRoot ? (
              <span
                className="inline-flex shrink-0 items-center text-muted-foreground/70"
                title="Project root worktree"
                aria-label="Project root worktree"
              >
                <FolderRootIcon className="size-3.5" />
              </span>
            ) : null}
            {renaming ? (
              <input
                value={renameTitle}
                className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 py-0.5 text-xs font-medium text-foreground outline-hidden focus:border-ring"
                autoFocus
                onBlur={commitRename}
                onChange={(event) => setRenameTitle(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  className={resolveSidebarStatusTextClassName(
                    props.worktree.aggregateStatus,
                    "min-w-0 cursor-default truncate text-xs font-medium text-foreground/85",
                  )}
                  title={
                    props.worktree.aggregateStatus === "idle"
                      ? displayTitle
                      : `${WORKTREE_STATUS_LABELS[props.worktree.aggregateStatus]}: ${displayTitle}`
                  }
                  aria-label={
                    props.worktree.aggregateStatus === "idle"
                      ? displayTitle
                      : `${WORKTREE_STATUS_LABELS[props.worktree.aggregateStatus]}: ${displayTitle}`
                  }
                  style={statusTextStyle}
                  onClick={handleTitleClick}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    startRename();
                  }}
                >
                  {displayTitle}
                </span>
                <WorktreeSourceControlBadges
                  issueNumber={props.worktree.worktree.issueNumber}
                  issueState={props.worktree.worktree.issueState}
                  prNumber={props.worktree.worktree.prNumber}
                  prState={props.worktree.worktree.prState}
                  prIsDraft={props.worktree.worktree.prIsDraft}
                  workItemProvider={props.worktree.worktree.workItemProvider}
                  workItemKey={props.worktree.worktree.workItemKey}
                  workItemState={props.worktree.worktree.workItemState}
                  workItemStateName={props.worktree.worktree.workItemStateName}
                  displayMode="prefer-pr"
                  onOpenLinkedItem={props.onOpenLinkedItem}
                />
              </span>
            )}
            <WorktreeOriginLabel worktree={props.worktree} />
            <WorktreeDiffStats worktree={props.worktree} />
            {props.worktree.shouldSuggestArchive && canManage ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onArchiveWorktree(props.worktree);
                }}
              >
                <ArchiveIcon className="size-3" />
                Archive?
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`New session in ${props.worktree.worktree.branch}`}
              className={`ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/55 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100 phone:opacity-100 ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onNewSession(props.worktree);
              }}
            >
              <PlusIcon className="size-3.5" />
            </button>
            <WorktreeMenu
              canManage={canManage}
              worktree={props.worktree}
              onArchiveWorktree={props.onArchiveWorktree}
              onCopyWorktreePath={props.onCopyWorktreePath}
              onDeleteWorktree={props.onDeleteWorktree}
              onNewSession={props.onNewSession}
              onOpenInEditor={props.onOpenInEditor}
              onRenameWorktree={startRename}
            />
          </ContextMenuTrigger>
          <ContextMenuPopup align="start" side="bottom" className="min-w-48">
            <WorktreeMenuItems
              canManage={canManage}
              worktree={props.worktree}
              onArchiveWorktree={props.onArchiveWorktree}
              onCopyWorktreePath={props.onCopyWorktreePath}
              onDeleteWorktree={props.onDeleteWorktree}
              onNewSession={props.onNewSession}
              onOpenInEditor={props.onOpenInEditor}
              onRenameWorktree={startRename}
            />
          </ContextMenuPopup>
        </ContextMenu>
      </SidebarMenuSubItem>

      {showEmptyState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div className="ml-5 flex h-6 items-center border-l border-sidebar-border/70 px-4 text-[10px] text-muted-foreground/60">
            No sessions yet
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {showSessions && visibleThreads.length > 0 ? (
        <SidebarWorktreeThreadRows
          orderedProjectThreadKeys={props.orderedProjectThreadKeys}
          renderThread={props.renderThread}
          resolveThreadGitStatusTarget={props.resolveThreadGitStatusTarget}
          visibleThreads={renderedThreads}
        />
      ) : null}
      {showSessions && hasOverflowingThreads ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <button
            type="button"
            aria-expanded={threadsExpanded}
            className="ml-5 flex h-6 cursor-pointer items-center border-l border-sidebar-border/70 px-4 text-left text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground/90"
            onClick={() => setThreadsExpanded((expanded) => !expanded)}
          >
            {threadsExpanded
              ? "Show less"
              : `Show ${visibleThreads.length - WORKTREE_THREAD_PREVIEW_LIMIT} more`}
          </button>
        </SidebarMenuSubItem>
      ) : null}
    </>
  );
});

const SidebarWorktreeThreadRows = memo(function SidebarWorktreeThreadRows(props: {
  orderedProjectThreadKeys: readonly string[];
  renderThread: (
    thread: SidebarTreeThread,
    orderedProjectThreadKeys: readonly string[],
    gitStatusTarget: GitStatusTarget | null | undefined,
  ) => React.ReactNode;
  resolveThreadGitStatusTarget: (thread: SidebarTreeThread) => SidebarThreadGitStatusTarget | null;
  visibleThreads: ReadonlyArray<SidebarTreeThread>;
}) {
  return (
    <>
      {props.visibleThreads.map((thread) => (
        <Fragment key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}>
          {props.renderThread(
            thread,
            props.orderedProjectThreadKeys,
            props.resolveThreadGitStatusTarget(thread),
          )}
        </Fragment>
      ))}
    </>
  );
});

function WorktreeMenuItems(props: {
  canManage: boolean;
  worktree: SidebarTreeWorktree;
  onArchiveWorktree: (worktree: SidebarTreeWorktree) => void;
  onCopyWorktreePath: (worktree: SidebarTreeWorktree) => void;
  onDeleteWorktree: (worktree: SidebarTreeWorktree) => void;
  onNewSession: (worktree: SidebarTreeWorktree) => void;
  onOpenInEditor: (worktree: SidebarTreeWorktree) => void;
  onRenameWorktree: () => void;
}) {
  return (
    <>
      <MenuItem onClick={() => props.onNewSession(props.worktree)}>
        <PlusIcon className="size-4" />
        New session here
      </MenuItem>
      <MenuItem onClick={props.onRenameWorktree}>
        <Edit3Icon className="size-4" />
        Rename worktree
      </MenuItem>
      <MenuItem onClick={() => props.onOpenInEditor(props.worktree)}>
        <ExternalLinkIcon className="size-4" />
        Open in editor
      </MenuItem>
      <MenuItem onClick={() => props.onCopyWorktreePath(props.worktree)}>
        <CopyIcon className="size-4" />
        Copy path
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled={!props.canManage} onClick={() => props.onArchiveWorktree(props.worktree)}>
        <ArchiveIcon className="size-4" />
        Archive worktree
      </MenuItem>
      <MenuItem
        disabled={!props.canManage}
        variant="destructive"
        onClick={() => props.onDeleteWorktree(props.worktree)}
      >
        <Trash2Icon className="size-4" />
        Delete worktree
      </MenuItem>
    </>
  );
}

function WorktreeMenu(props: {
  canManage: boolean;
  worktree: SidebarTreeWorktree;
  onArchiveWorktree: (worktree: SidebarTreeWorktree) => void;
  onCopyWorktreePath: (worktree: SidebarTreeWorktree) => void;
  onDeleteWorktree: (worktree: SidebarTreeWorktree) => void;
  onNewSession: (worktree: SidebarTreeWorktree) => void;
  onOpenInEditor: (worktree: SidebarTreeWorktree) => void;
  onRenameWorktree: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/55 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100 phone:opacity-100 ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        aria-label={`Worktree actions for ${props.worktree.worktree.branch}`}
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <WorktreeMenuItems
          canManage={props.canManage}
          worktree={props.worktree}
          onArchiveWorktree={props.onArchiveWorktree}
          onCopyWorktreePath={props.onCopyWorktreePath}
          onDeleteWorktree={props.onDeleteWorktree}
          onNewSession={props.onNewSession}
          onOpenInEditor={props.onOpenInEditor}
          onRenameWorktree={props.onRenameWorktree}
        />
      </MenuPopup>
    </Menu>
  );
}

function WorktreeOriginLabel({ worktree }: { worktree: SidebarTreeWorktree }) {
  const origin = worktree.worktree.origin;
  if (origin === "main" || origin === "branch") {
    return null;
  }
  if (origin === "pr" && worktree.worktree.prNumber != null) {
    return null;
  }
  if (origin === "issue" && worktree.worktree.issueNumber != null) {
    return null;
  }
  if (origin === "issue" && worktree.worktree.workItemKey) {
    return null;
  }
  const label = origin === "pr" ? "PR" : origin === "issue" ? "Issue" : "Manual";
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
      {label}
    </span>
  );
}

function getWorktreeDisplayTitle(worktree: SidebarTreeWorktree): string {
  return worktree.worktree.title ?? worktree.worktree.branch;
}

/**
 * Whether archive/delete apply to this row. The project root has no worktree to
 * remove, and a synthetic row is a grouping the sidebar derived from its
 * sessions — the server has nothing registered to act on, so offering to delete
 * it can only destroy the sessions that produced it.
 */
function canManageWorktree(worktree: SidebarWorktree, projectCwd: string): boolean {
  return (
    !isProjectRootWorktree(worktree, projectCwd) && !isSyntheticWorktreeId(worktree.worktreeId)
  );
}

function isProjectRootWorktree(worktree: SidebarWorktree, projectCwd: string): boolean {
  if (worktree.origin === "main") return true;
  if (worktree.worktreePath === null) return true;
  return normalizeWorktreePath(worktree.worktreePath) === normalizeWorktreePath(projectCwd);
}

function WorktreeDiffStats({ worktree }: { worktree: SidebarTreeWorktree }) {
  if (!worktree.diffStats) {
    return null;
  }
  return (
    <span className="shrink-0 text-[10px] text-muted-foreground/70">
      +{worktree.diffStats.added} / -{worktree.diffStats.removed}
    </span>
  );
}

function getOrderedThreadKeys(
  treeProject: SidebarTreeProject,
  visibleThreadKeys: ReadonlySet<string> | null,
): string[] {
  const draftKeys = treeProject.draftSessions
    .filter((thread) => shouldRenderThread(thread, visibleThreadKeys))
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
  const worktreeKeys = treeProject.worktrees.flatMap((worktree) =>
    worktree.sessions
      .filter((thread) => shouldRenderThread(thread, visibleThreadKeys))
      .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  return [...draftKeys, ...worktreeKeys];
}

function getVisibleThreadsForWorktree(
  worktree: SidebarTreeWorktree,
  visibleThreadKeys: ReadonlySet<string> | null,
): SidebarTreeThread[] {
  return worktree.sessions.filter((thread) => shouldRenderThread(thread, visibleThreadKeys));
}

function shouldRenderThread(
  thread: SidebarTreeThread,
  visibleThreadKeys: ReadonlySet<string> | null,
): boolean {
  if (thread.archivedAt !== null) {
    return false;
  }
  if (!visibleThreadKeys) {
    return true;
  }
  return visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
}
