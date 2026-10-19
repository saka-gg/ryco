import {
  type ChangeRequest,
  type GitActionProgressEvent,
  type GitActionProgressPhase,
  type GitRunStackedActionResult,
  type GitStackedAction,
  type ScopedThreadRef,
  type VcsStatusResult,
  WorktreeId,
} from "@ryco/contracts";
import { scopeProjectRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { ensureEnvironmentApi, readEnvironmentApi } from "~/environmentApi";
import { requireEnvironmentConnection } from "~/environments/runtime";
import {
  createGitActionReporter,
  gitActionNoticeKind,
  type GitActionReporter,
} from "~/gitActionNotices";
import { useEvent } from "~/hooks/useEvent";
import { useGitStatus } from "~/lib/gitStatusState";
import { newCommandId, randomUUID } from "~/lib/utils";
import { createVisibilityAwarePoller } from "~/lib/visibilityPolling";
import { readLocalApi } from "~/localApi";
import { webAppLifecycle } from "~/platform/appLifecycle";
import {
  GIT_USER_ACTION_KIND,
  gitMutationTrackingKey,
  gitScopeKey,
  useGitActionActivity,
  useGitMutation,
} from "~/rpc/useGit";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useStore } from "~/store";
import {
  createProjectSelectorByRef,
  createThreadSelectorByRef,
  createWorktreeSelector,
} from "~/storeSelectors";
import {
  buildGitActionProgressStages,
  type DefaultBranchConfirmableAction,
  mergeDetectedChangeRequestIntoGitStatus,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";

/**
 * Runs the checkout's git actions: commit / push / pull request (one stacked
 * server action), pull, and opening the open pull request. Every git surface
 * (the split button, the crown's Ship button) shares this, so they report
 * progress, confirm default-branch pushes and sync the thread's branch the
 * same way. Pair it with {@link GitDefaultBranchActionDialog}, which asks
 * before an action pushes to the default branch.
 */

export interface GitActionPostPushEvent {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadKey: string | null;
  readonly cwd: string;
  readonly action: GitStackedAction;
  readonly commitSha: string | null;
  readonly pullRequestNumber: number | null;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

interface ActiveGitActionProgress {
  reporter: GitActionReporter;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitStackedActionArgs {
  actionId: string;
  action: GitStackedAction;
  commitMessage?: string;
  featureBranch?: boolean;
  filePaths?: string[];
  worktreeId?: WorktreeId | null;
  onProgress?: (event: GitActionProgressEvent) => void;
}

export interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  /** Called as the server starts each phase (commit, push, PR), for callers tracking steps. */
  onProgressPhase?: (phase: GitActionProgressPhase) => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  filePaths?: string[];
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

/** The thread the git controls act for, and how to record the branch its checkout is on. */
export function useThreadBranchPersistence(
  activeThreadRef: ScopedThreadRef | null,
  draftId: DraftId | undefined,
) {
  const activeServerThreadSelector = useMemo(
    () => createThreadSelectorByRef(activeThreadRef),
    [activeThreadRef],
  );
  const activeServerThread = useStore(activeServerThreadSelector);
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeWorktreeSelector = useMemo(
    () => createWorktreeSelector(activeThreadRef?.environmentId, activeServerThread?.worktreeId),
    [activeThreadRef?.environmentId, activeServerThread?.worktreeId],
  );
  const activeWorktree = useStore(activeWorktreeSelector);
  const projectOwner = activeServerThread ?? activeDraftThread ?? null;
  const projectEnvironmentId = projectOwner?.environmentId ?? null;
  const projectId = projectOwner?.projectId ?? null;
  const activeProjectSelector = useMemo(
    () =>
      createProjectSelectorByRef(
        projectEnvironmentId && projectId ? scopeProjectRef(projectEnvironmentId, projectId) : null,
      ),
    [projectEnvironmentId, projectId],
  );
  const activeProjectCwd = useStore(activeProjectSelector)?.cwd ?? null;
  const activeThreadCwd =
    (activeServerThread !== undefined
      ? activeServerThread.worktreePath
      : (activeDraftThread?.worktreePath ?? null)) ?? activeProjectCwd;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setThreadBranch = useStore((store) => store.setThreadBranch);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        const worktreePath = activeServerThread.worktreePath;
        const api = readEnvironmentApi(activeThreadRef.environmentId);
        // A branch renamed in the checkout (by the agent, or in a terminal) also
        // renames its worktree record, so the sidebar and inbox show the live name.
        if (
          api &&
          branch !== null &&
          worktreePath !== null &&
          activeWorktree !== null &&
          activeWorktree.branch !== branch
        ) {
          void api.orchestration
            .dispatchCommand({
              type: "worktree.meta.update",
              commandId: newCommandId(),
              worktreeId: WorktreeId.make(activeWorktree.id),
              branch,
              changedAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadRef.threadId,
              branch,
              worktreePath,
            })
            .catch(() => undefined);
        }

        setThreadBranch(activeThreadRef, branch, worktreePath);
        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      activeWorktree,
      draftId,
      setDraftThreadContext,
      setThreadBranch,
    ],
  );

  return {
    activeServerThread,
    activeDraftThread,
    activeThreadCwd,
    activeWorktreeBranch: activeWorktree?.branch ?? null,
    persistThreadBranchSync,
  };
}

export interface GitActionRunnerInput {
  readonly gitCwd: string | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly draftId?: DraftId | undefined;
  readonly detectedChangeRequest?: ChangeRequest | null | undefined;
  readonly onPostPush?: ((event: GitActionPostPushEvent) => void) | undefined;
}

export type GitActionRunner = ReturnType<typeof useGitActionRunner>;

export function useGitActionRunner({
  gitCwd,
  activeThreadRef,
  draftId,
  detectedChangeRequest = null,
  onPostPush,
}: GitActionRunnerInput) {
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);

  const setActiveGitActionProgress = useCallback((progress: ActiveGitActionProgress) => {
    activeGitActionProgressRef.current = progress;
  }, []);

  const clearActiveGitActionProgress = useCallback(() => {
    activeGitActionProgressRef.current = null;
  }, []);

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    progress.reporter.running(progress.title, resolveProgressDescription(progress));
  }, []);

  const { activeServerThread, persistThreadBranchSync } = useThreadBranchPersistence(
    activeThreadRef,
    draftId,
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  const { data: gitStatus = null, error: gitStatusError } = useGitStatus({
    environmentId: activeEnvironmentId,
    cwd: gitCwd,
  });
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = useMemo(
    () => mergeDetectedChangeRequestIntoGitStatus(gitStatus, detectedChangeRequest),
    [detectedChangeRequest, gitStatus],
  );

  const gitScopes = useMemo(() => (gitCwd ? [gitScopeKey(gitCwd)] : []), [gitCwd]);
  const runStackedActionTrackingKey = gitMutationTrackingKey(
    GIT_USER_ACTION_KIND.runStackedAction,
    activeEnvironmentId,
    gitCwd,
  );
  const pullTrackingKey = gitMutationTrackingKey(
    GIT_USER_ACTION_KIND.pull,
    activeEnvironmentId,
    gitCwd,
  );

  const initMutation = useGitMutation({
    mutationFn: () => {
      if (!gitCwd || !activeEnvironmentId) {
        throw new Error("Git init is unavailable.");
      }
      return ensureEnvironmentApi(activeEnvironmentId).vcs.init({ cwd: gitCwd });
    },
    invalidates: gitScopes,
    invalidateOn: "settled",
  });

  const runImmediateGitActionMutation = useGitMutation<
    RunGitStackedActionArgs,
    GitRunStackedActionResult
  >({
    mutationFn: ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      worktreeId,
      onProgress,
    }) => {
      if (!gitCwd || !activeEnvironmentId) {
        throw new Error("Git action is unavailable.");
      }
      return requireEnvironmentConnection(activeEnvironmentId).client.git.runStackedAction(
        {
          action,
          actionId,
          cwd: gitCwd,
          ...(worktreeId ? { worktreeId } : {}),
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch: true } : {}),
          ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    invalidates: gitScopes,
    trackingKey: runStackedActionTrackingKey,
  });
  const pullMutation = useGitMutation({
    mutationFn: () => {
      if (!gitCwd || !activeEnvironmentId) {
        throw new Error("Git pull is unavailable.");
      }
      return ensureEnvironmentApi(activeEnvironmentId).vcs.pull({ cwd: gitCwd });
    },
    invalidates: gitScopes,
    trackingKey: pullTrackingKey,
  });

  const isGitActionRunning = useGitActionActivity(activeEnvironmentId, gitCwd);

  const isDefaultRef = useMemo(() => {
    return gitStatusForActions?.isDefaultRef ?? false;
  }, [gitStatusForActions?.isDefaultRef]);

  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
        terminology: changeRequestTerminology,
      })
    : null;

  const openExistingPr = useCallback(async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: err instanceof Error ? err.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatusForActions, threadToastData]);

  // A result's follow-up ("Create PR") runs another action through this runner.
  const followUpRef = useRef<((input: RunGitActionWithToastInput) => Promise<void>) | null>(null);
  const runGitActionWithToast = useEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      onProgressPhase,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.refName ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const actionThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
      const actionId = randomUUID();
      // The crown showing this checkout reports the action; otherwise toasts do.
      const reporter = createGitActionReporter({
        id: actionId,
        kind: gitActionNoticeKind(action),
        environmentId: activeEnvironmentId,
        cwd: gitCwd,
        toastData: threadToastData ? { ...threadToastData } : undefined,
      });
      reporter.running(progressStages[0] ?? "Running git action...", "Waiting for Git...");

      setActiveGitActionProgress({
        reporter,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      });

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            onProgressPhase?.(event.phase);
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the rejected mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        worktreeId: activeServerThread?.worktreeId
          ? WorktreeId.make(activeServerThread.worktreeId)
          : null,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });
      // Ticks the elapsed time for as long as the action runs, not as long as
      // this control is mounted: a hover preview closes right after the click.
      const elapsedTicker = createVisibilityAwarePoller({
        lifecycle: webAppLifecycle,
        run: () => {
          updateActiveProgressToast();
          return Promise.resolve();
        },
        resolveDelayMs: () => 1_000,
        runImmediately: false,
      });

      try {
        const result = await promise;
        elapsedTicker.stop();
        clearActiveGitActionProgress();
        syncThreadBranchAfterGitAction(result);
        if (result.push.status === "pushed" && activeEnvironmentId && gitCwd) {
          onPostPush?.({
            environmentId: activeEnvironmentId,
            threadKey: actionThreadKey,
            cwd: gitCwd,
            action: result.action,
            commitSha: result.commit.commitSha ?? null,
            pullRequestNumber: result.pr.number ?? null,
          });
        }
        const toastCta = result.toast.cta;
        const followUp =
          toastCta.kind === "run_action"
            ? {
                label: toastCta.label,
                onClick: () => void followUpRef.current?.({ action: toastCta.action.kind }),
              }
            : toastCta.kind === "open_pr"
              ? {
                  label: toastCta.label,
                  onClick: () => void readLocalApi()?.shell.openExternal(toastCta.url),
                }
              : undefined;
        reporter.succeeded({
          title: result.toast.title,
          description: result.toast.description,
          action: followUp,
        });
      } catch (err) {
        elapsedTicker.stop();
        clearActiveGitActionProgress();
        reporter.failed({
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
        });
      }
    },
  );

  const continuePendingDefaultBranchAction = useEvent(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  });

  const checkoutFeatureBranchAndContinuePendingAction = useEvent(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  });

  /** Pulls the checkout; resolves whether the pull went through. */
  const runPull = useEvent((): Promise<boolean> => {
    const reporter = createGitActionReporter({
      id: randomUUID(),
      kind: "pull",
      environmentId: activeEnvironmentId,
      cwd: gitCwd,
      toastData: threadToastData,
    });
    reporter.running("Pulling...");
    return pullMutation.mutateAsync().then(
      (result) => {
        reporter.succeeded({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`
              : `${result.refName} is already synchronized.`,
        });
        return true;
      },
      (err: unknown) => {
        reporter.failed({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
        });
        return false;
      },
    );
  });

  useEffect(() => {
    followUpRef.current = runGitActionWithToast;
  }, [runGitActionWithToast]);

  const abortPendingDefaultBranchAction = useCallback(
    () => setPendingDefaultBranchAction(null),
    [],
  );

  return {
    activeEnvironmentId,
    threadToastData,
    gitStatus,
    gitStatusError,
    gitStatusForActions,
    changeRequestTerminology,
    SourceControlIcon,
    isRepo,
    hasPrimaryRemote,
    isGitActionRunning,
    isDefaultRef,
    quickAction,
    quickActionDisabledReason,
    initMutation,
    runGitActionWithToast,
    runPull,
    openExistingPr,
    pendingDefaultBranchActionCopy,
    continuePendingDefaultBranchAction,
    checkoutFeatureBranchAndContinuePendingAction,
    abortPendingDefaultBranchAction,
  };
}

/** Asks before a runner's action pushes to the default branch (or offers a feature branch). */
export function GitDefaultBranchActionDialog({ runner }: { readonly runner: GitActionRunner }) {
  return (
    <Dialog
      open={runner.pendingDefaultBranchActionCopy !== null}
      onOpenChange={(open) => {
        if (!open) {
          runner.abortPendingDefaultBranchAction();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {runner.pendingDefaultBranchActionCopy?.title ?? "Run action on default refName?"}
          </DialogTitle>
          <DialogDescription>
            {runner.pendingDefaultBranchActionCopy?.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-wrap sm:items-center">
          <Button
            className="w-full sm:mr-auto sm:w-auto"
            variant="outline"
            size="sm"
            onClick={() => runner.abortPendingDefaultBranchAction()}
          >
            Abort
          </Button>
          <Button
            className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
            variant="outline"
            size="sm"
            onClick={runner.continuePendingDefaultBranchAction}
          >
            {runner.pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
          </Button>
          <Button
            className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
            size="sm"
            onClick={runner.checkoutFeatureBranchAndContinuePendingAction}
          >
            Checkout feature branch & continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
