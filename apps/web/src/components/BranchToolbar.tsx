import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { GitBranchIcon, GitPullRequestIcon, LockIcon, TerminalSquareIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { loadThreadTerminalDrawer } from "../workspacePanelPreload";
import {
  resolveEffectiveEnvMode,
  type EnvMode,
  type EnvironmentOption,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { RollingText } from "./chat/RollingText";
import { TERMINAL_RUNNING_TONE, TerminalRunningDot } from "./ThreadTerminalStatus";
import { formatTerminalRunningLine } from "./ThreadTerminalStatus.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { LazyNewWorktreeDialog } from "./worktrees/lazyWorktreeDialogs";

/**
 * Hover or focus on the terminal toggle: fetch the drawer's xterm chunk so the
 * click only waits on the PTY (which the drawer's open already starts early).
 * Code only, never a terminal open.
 */
function preloadTerminalDrawerForIntent(): void {
  void loadThreadTerminalDrawer().catch(() => undefined);
}

/** Hover or focus on "From PR / issue": the dialog mounts on its chunk. */
function preloadNewWorktreeDialogForIntent(): void {
  void LazyNewWorktreeDialog.preload();
}

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /**
   * Opens the full `NewWorktreeDialog` (branches / PRs / issues / Jira). The
   * inline chips cover the fast path; this is the escape hatch for worktrees
   * sourced from a tracked item.
   */
  onOpenWorktreeSources?: () => void;
  /**
   * While the thread is empty the "Work in …" row above the composer owns the
   * project, location, branch and environment controls, so the toolbar drops
   * them and keeps only the terminal toggle rather than offering the same
   * settings twice on one screen.
   */
  contextControlsHoisted?: boolean;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  onToggleTerminal: () => void;
  terminalCount: number;
  /** Terminals running a process; they keep running behind a closed drawer. */
  runningTerminalCount: number;
  /**
   * A first send is setting up this draft's new worktree: where it runs is
   * decided, so the choices give way to what was chosen. `branch` is the new
   * worktree's branch once it exists.
   */
  worktreeLaunch?: { readonly branch: string | null };
}

// The static twins of the toolbar's ghost `xs` controls, so a locked label
// takes exactly the place of the control it replaces.
const LOCKED_TOOLBAR_LABEL_CLASS_NAME =
  "worktree-setup-enter inline-flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md px-[calc(--spacing(2)-1px)] font-medium text-muted-foreground/70 text-sm sm:h-6 sm:text-xs";

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  draftId,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  onOpenWorktreeSources,
  contextControlsHoisted = false,
  availableEnvironments,
  onEnvironmentChange,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  onToggleTerminal,
  terminalCount,
  runningTerminalCount,
  worktreeLaunch,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);
  const hasServerThread = serverThread !== undefined;
  const hasActiveThread = hasServerThread || draftThread !== null;

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  // Only an unlocked draft can still choose where it runs: a server thread, or
  // one with messages or a live session, is already bound to its checkout.
  const canChooseEnvMode = !hasServerThread && draftThread !== null && !envLocked;
  const envMode = resolveEffectiveEnvMode({
    activeWorktreePath: serverThread?.worktreePath ?? draftThread?.worktreePath ?? null,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });
  // Clearing `worktreePath` is load-bearing: `resolveEffectiveEnvMode` reports
  // "local" whenever a path is set, so a stale one would silently defeat the
  // switch back to worktree mode.
  const handleEnvModeChange = useCallback(
    (nextEnvMode: EnvMode) => {
      setDraftThreadContext(draftId ?? threadRef, {
        envMode: nextEnvMode,
        worktreePath: null,
      });
      onComposerFocusRequest?.();
    },
    [draftId, onComposerFocusRequest, setDraftThreadContext, threadRef],
  );

  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-(--chat-composer-max-width) items-center gap-1 px-2.5 pb-3 pt-1 sm:px-3">
      {contextControlsHoisted ? null : (
        <div className="flex min-w-0 shrink items-center gap-0.5">
          {/* A started thread already names its project in the header breadcrumb;
              only a draft keeps the switcher, since it can still move. */}
          {canChooseEnvMode && draftId ? (
            <ProjectSwitcher
              activeProjectId={activeProject.id}
              activeProjectEnvironmentId={activeProject.environmentId}
              appearance="chip"
              draftId={draftId}
              label={activeProject.name}
            />
          ) : null}

          {showEnvironmentPicker && availableEnvironments && onEnvironmentChange && (
            <BranchToolbarEnvironmentSelector
              envLocked={envLocked}
              environmentId={environmentId}
              availableEnvironments={availableEnvironments}
              onEnvironmentChange={onEnvironmentChange}
            />
          )}

          {canChooseEnvMode ? (
            <BranchToolbarEnvModeSelector value={envMode} onChange={handleEnvModeChange} />
          ) : worktreeLaunch ? (
            <span className={LOCKED_TOOLBAR_LABEL_CLASS_NAME}>
              <LockIcon className="size-3" aria-hidden />
              New worktree
            </span>
          ) : null}
        </div>
      )}

      <div className="flex flex-1 items-center justify-center gap-1 phone:hidden">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="font-medium text-muted-foreground/70 hover:text-foreground/80"
                disabled={!terminalAvailable}
                onClick={onToggleTerminal}
                onPointerEnter={terminalOpen ? undefined : preloadTerminalDrawerForIntent}
                onFocus={terminalOpen ? undefined : preloadTerminalDrawerForIntent}
                aria-label="Toggle terminal drawer"
                aria-pressed={terminalOpen}
              >
                <span
                  className={cn(
                    "relative inline-flex shrink-0",
                    runningTerminalCount > 0 && TERMINAL_RUNNING_TONE,
                  )}
                >
                  <TerminalSquareIcon className="size-3" />
                  {runningTerminalCount > 0 && <TerminalRunningDot className="ring-background" />}
                </span>
                <span>{terminalOpen ? "Close Terminal" : "Open Terminal"}</span>
                {terminalCount >= 2 && (
                  <span
                    className="text-muted-foreground/70 tabular-nums"
                    aria-label={`${terminalCount} open terminals`}
                  >
                    · {terminalCount}
                  </span>
                )}
                {runningTerminalCount > 0 && (
                  <span
                    className={cn("tabular-nums", TERMINAL_RUNNING_TONE)}
                    aria-label={formatTerminalRunningLine(runningTerminalCount)}
                  >
                    · {terminalCount >= 2 ? `${runningTerminalCount} running` : "running"}
                  </span>
                )}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
      </div>

      {contextControlsHoisted ? null : (
        <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 md:ml-auto md:flex-none">
          {worktreeLaunch ? (
            <span
              className={LOCKED_TOOLBAR_LABEL_CLASS_NAME}
              data-testid="branch-toolbar-launch-branch"
            >
              <GitBranchIcon className="size-3 shrink-0" aria-hidden />
              <RollingText
                className="min-w-0 max-w-[240px]"
                text={
                  worktreeLaunch.branch ??
                  (draftThread?.branch ? `From ${draftThread.branch}` : "New branch")
                }
              />
            </span>
          ) : null}
          {canChooseEnvMode && onOpenWorktreeSources ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0 font-medium text-muted-foreground/70 hover:text-foreground/80 phone:hidden"
                    onClick={onOpenWorktreeSources}
                    onPointerEnter={preloadNewWorktreeDialogForIntent}
                    onFocus={preloadNewWorktreeDialogForIntent}
                    data-testid="branch-toolbar-worktree-sources"
                  >
                    <GitPullRequestIcon className="size-3 shrink-0" />
                    <span>From PR / issue</span>
                  </Button>
                }
              />
              <TooltipPopup side="top">
                Create a worktree from a pull request, issue, or Jira item
              </TooltipPopup>
            </Tooltip>
          ) : null}

          {worktreeLaunch ? null : (
            <BranchToolbarBranchSelector
              className="min-w-0"
              environmentId={environmentId}
              threadId={threadId}
              {...(draftId ? { draftId } : {})}
              envLocked={envLocked}
              {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
              {...(onActiveThreadBranchOverrideChange
                ? { onActiveThreadBranchOverrideChange }
                : {})}
              {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            />
          )}
        </div>
      )}
    </div>
  );
});
