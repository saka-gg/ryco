import { ArchiveIcon, CloudIcon, PinIcon, TerminalIcon, XIcon } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import type { ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { type GitStatusTarget, useGitStatus, type GitStatusState } from "../../lib/gitStatusState";
import { cn, isMacPlatform } from "../../lib/utils";
import { type AppState, selectProjectByRef, useStore } from "../../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { type DraftId } from "../../composerDraftStore";
import type { SidebarThreadSummary } from "../../types";
import {
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "../ThreadStatusIndicators";
import {
  canArchiveSidebarThread,
  isTrailingDoubleClick,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME,
  shouldEnableSidebarRowGitStatus,
} from "../Sidebar.logic";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolveSidebarStatusTextStyle,
  resolveThreadStatusTextClassName,
} from "./sidebarStatusText";
import { useIsIntersectingViewport } from "./hooks/useHasIntersectedViewport";

export interface SidebarThreadRowProps {
  thread: SidebarThreadSummary & { draftId?: DraftId | undefined };
  projectCwd: string | null;
  gitStatusTarget?: GitStatusTarget | null | undefined;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  isTreeChild?: boolean | undefined;
  jumpLabel: string | null;
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
  closeThread: (
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
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  if (props.gitStatusTarget !== undefined) {
    return <SidebarThreadRowWithGitStatusTarget {...props} target={props.gitStatusTarget} />;
  }

  return <SidebarThreadRowWithGitStatusFallback {...props} />;
});

export function SidebarThreadRowWithGitStatusFallback(props: SidebarThreadRowProps) {
  const { thread } = props;
  // For grouped projects, the thread may belong to a different environment
  // than the representative project.  Look up the thread's own project cwd
  // so git status (and thus PR detection) queries the correct path.
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd ?? props.projectCwd;
  const target = useMemo(
    () => ({
      environmentId: thread.environmentId,
      cwd: thread.branch != null ? gitCwd : null,
    }),
    [gitCwd, thread.branch, thread.environmentId],
  );

  return <SidebarThreadRowWithGitStatusTarget {...props} target={target} />;
}

function SidebarThreadRowWithGitStatusTarget(
  props: SidebarThreadRowProps & { readonly target: GitStatusTarget | null },
) {
  const [setVisibilityNode, isIntersecting] = useIsIntersectingViewport();
  const gitStatus = useGitStatus(props.target ?? { environmentId: null, cwd: null }, {
    enabled: shouldEnableSidebarRowGitStatus({
      isActive: props.isActive,
      isIntersecting,
    }),
  });

  return (
    <SidebarThreadRowContent
      {...props}
      gitStatus={props.target === null ? null : gitStatus}
      setVisibilityNode={setVisibilityNode}
    />
  );
}

export const SidebarThreadRowContent = memo(function SidebarThreadRowContent(
  props: SidebarThreadRowProps & {
    gitStatus: GitStatusState | null;
    setVisibilityNode?: ((node: HTMLElement | null) => void) | undefined;
  },
) {
  const {
    orderedProjectThreadKeys,
    isActive,
    jumpLabel,
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
    handleThreadClick,
    navigateToThread,
    navigateToDraft,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    closeThread,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    thread,
  } = props;
  const gitStatus = props.gitStatus;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const draftId = thread.draftId ?? null;
  const isMobile = usePresentationTier() === "phone";
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isPinned = useUiStateStore((state) => state.pinnedThreadKeys[threadKey] === true);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const hasSelection = useThreadSelectionStore((state) => state.selectedThreadKeys.size > 0);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (s) => s.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (s) => s.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const pr = gitStatus ? resolveThreadPr(thread.branch, gitStatus.data) : null;
  const prStatus = prStatusIndicator(pr, gitStatus?.data?.sourceControlProvider);
  const PrStatusIcon = prStatus?.Icon;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const canArchiveThread = !draftId && canArchiveSidebarThread(thread);
  const canCloseThread = (props.isTreeChild || draftId !== null) && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 phone:pointer-fine:pr-10 phone:pointer-coarse:pr-20 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const threadStatusTextStyle = useMemo(
    () => (threadStatus ? resolveSidebarStatusTextStyle(thread.title) : undefined),
    [thread.title, threadStatus],
  );
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      if (draftId) {
        const isMac = isMacPlatform(navigator.platform);
        if ((isMac ? event.metaKey : event.ctrlKey) || event.shiftKey) {
          event.preventDefault();
          return;
        }
        // Don't navigate on the trailing click of a double-click, to match the
        // behavior for non-draft rows where the second click is suppressed by
        // isTrailingDoubleClick in handleThreadClick.
        if (isTrailingDoubleClick(event.detail)) {
          return;
        }
        navigateToDraft(draftId, threadRef);
        return;
      }
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [draftId, handleThreadClick, navigateToDraft, orderedProjectThreadKeys, threadRef],
  );
  const handleRowDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // Already renaming this row: a double-click on the row chrome (outside the
      // input) must not restart and discard the in-progress edit.
      if (renamingThreadKey === threadKey) return;
      // Drafts are unsaved threads with no rename target; they navigate instead.
      if (draftId) return;
      // On mobile the first tap navigates and closes the sidebar sheet, so the
      // inline rename can't be shown. Renaming there stays on the context menu.
      if (isMobile) return;
      // cmd/ctrl/shift double-clicks are multi-select intent, not rename.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Ignore double-clicks bubbling from nested controls (PR status, archive /
      // close buttons) — only the row body should enter inline rename.
      if ((event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      startThreadRename(threadKey, thread.title);
    },
    [draftId, isMobile, renamingThreadKey, startThreadRename, threadKey, thread.title],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (draftId) {
        navigateToDraft(draftId, threadRef);
        return;
      }
      navigateToThread(threadRef);
    },
    [draftId, navigateToDraft, navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (draftId) {
        if (hasSelection) {
          clearSelection();
        }
        return;
      }
      if (hasSelection && isSelected) {
        void handleMultiSelectContextMenu({
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [
      clearSelection,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      draftId,
      hasSelection,
      isSelected,
      threadRef,
    ],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!prStatus) return;
      openPrLink(event, prStatus.url);
    },
    [openPrLink, prStatus],
  );
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  // Keep clicks/double-clicks inside the rename input from bubbling to the row.
  // Without stopping `dblclick`, double-clicking to select a word would re-fire
  // the row's rename handler and reset the in-progress edit back to the title.
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );
  const handleCloseClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void closeThread(thread);
    },
    [closeThread, thread],
  );
  const rowButtonRender = useMemo(() => <div role="button" tabIndex={0} />, []);

  return (
    <SidebarMenuSubItem
      ref={props.setVisibilityNode}
      className={cn(
        "w-full",
        props.isTreeChild &&
          "pl-5 before:absolute before:top-0 before:bottom-0 before:left-2 before:w-px before:bg-sidebar-border/70 after:absolute after:left-2 after:top-1/2 after:h-px after:w-3 after:bg-sidebar-border/70",
      )}
      data-thread-item
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <SidebarMenuSubButton
        render={rowButtonRender}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate`}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && PrStatusIcon && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={handlePrClick}
                  >
                    <PrStatusIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="min-w-0 flex-1 truncate text-base sm:text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
              onDoubleClick={handleRenameInputClick}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={
                      threadStatus ? `${threadStatus.label}: ${thread.title}` : thread.title
                    }
                    className="flex min-w-0 flex-1 items-center gap-1"
                  >
                    <span
                      className={resolveThreadStatusTextClassName(
                        threadStatus,
                        "min-w-0 flex-1 truncate text-xs",
                      )}
                      style={threadStatusTextStyle}
                      data-testid={`thread-title-${thread.id}`}
                    >
                      {thread.title}
                    </span>
                    {draftId ? (
                      <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        Draft
                      </span>
                    ) : null}
                    {isPinned ? (
                      <PinIcon
                        className="size-3 shrink-0 text-muted-foreground/55"
                        aria-label="Pinned"
                      />
                    ) : null}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {threadStatus ? `${threadStatus.label}: ${thread.title}` : thread.title}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus && (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className="size-3" />
            </span>
          )}
          <div
            className={`flex min-w-12 justify-end ${
              isRemoteThread
                ? "phone:pointer-fine:min-w-24 phone:pointer-coarse:min-w-34"
                : "phone:pointer-fine:min-w-20 phone:pointer-coarse:min-w-30"
            }`}
          >
            {isConfirmingArchive ? (
              <button
                ref={handleConfirmArchiveRef}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40 phone:pointer-coarse:h-8 phone:pointer-coarse:after:absolute phone:pointer-coarse:after:top-1/2 phone:pointer-coarse:after:left-1/2 phone:pointer-coarse:after:h-11 phone:pointer-coarse:after:w-full phone:pointer-coarse:after:min-w-11 phone:pointer-coarse:after:-translate-x-1/2 phone:pointer-coarse:after:-translate-y-1/2"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleConfirmArchiveClick}
              >
                Confirm
              </button>
            ) : canCloseThread || (canArchiveThread && !isThreadRunning) ? (
              <div className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 phone:pointer-coarse:gap-3 opacity-0 transition-opacity duration-150 phone:pointer-events-auto phone:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                {canCloseThread ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-close-${thread.id}`}
                          aria-label={`Close ${thread.title}`}
                          className={`inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleCloseClick}
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      }
                    />
                    <TooltipPopup side="top">Close</TooltipPopup>
                  </Tooltip>
                ) : null}
                {canArchiveThread && !isThreadRunning && appSettingsConfirmThreadArchive ? (
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className={`inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleStartArchiveConfirmation}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                ) : null}
                {canArchiveThread && !isThreadRunning && !appSettingsConfirmThreadArchive ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className={`inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${SIDEBAR_ROW_ACTION_COARSE_CLASS_NAME}`}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleArchiveImmediateClick}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      }
                    />
                    <TooltipPopup side="top">Archive</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            ) : null}
            <span className={threadMetaClassName}>
              <span className="inline-flex items-center gap-1">
                {isRemoteThread && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={threadEnvironmentLabel ?? "Remote"}
                          className="inline-flex h-5 items-center justify-center"
                        />
                      }
                    >
                      <CloudIcon className="block size-3 text-muted-foreground/60" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
                  </Tooltip>
                )}
                {jumpLabel ? (
                  <span
                    className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                    title={jumpLabel}
                  >
                    {jumpLabel}
                  </span>
                ) : (
                  <span
                    className={`text-[10px] ${
                      isHighlighted
                        ? "text-foreground/72 dark:text-foreground/82"
                        : "text-muted-foreground/40"
                    }`}
                  >
                    {formatRelativeTimeLabel(
                      thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                    )}
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});
