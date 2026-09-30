import type { ChangeRequest, EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invalidateSourceControl } from "~/rpc/useSourceControl";
import { cn } from "~/lib/utils";
import PlanSidebar from "../PlanSidebar";
import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import type { DraftId } from "../../composerDraftStore";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import GitActionsControl, { type GitActionPostPushEvent } from "../GitActionsControl";
import {
  createPostPushWorkflowDiscoveryWatch,
  type PostPushWorkflowDiscoveryWatch,
} from "../postPushWorkflowDiscovery.logic";
import { useChatOverviewModel, type ChatOverviewModelInput } from "./useChatOverviewModel";

export const OVERVIEW_FLOATING_EXIT_DURATION_MS = 260;

/**
 * Floating overview overlay, kept for the frozen phone tier (see AGENTS.md).
 * The desktop tier presents the overview as the rail instead.
 */
export function FloatingOverviewMotionFrame(props: {
  animate: boolean;
  children: ReactNode;
  open: boolean;
}) {
  const [entered, setEntered] = useState(!props.animate && props.open);

  useEffect(() => {
    if (!props.animate) {
      setEntered(props.open);
      return;
    }

    if (!props.open) {
      setEntered(false);
      return;
    }

    const frameId = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [props.animate, props.open]);

  const active = props.animate ? props.open && entered : props.open;

  return (
    <div className="pointer-events-none absolute top-[calc(var(--chat-header-clearance,0px)+0.75rem)] right-3 z-40">
      <div
        aria-hidden={props.open ? undefined : true}
        inert={props.open ? undefined : true}
        className={cn(
          "origin-top-right transition-[translate,opacity] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform motion-reduce:transition-none",
          active ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

/** Presentation-only props; the data inputs are {@link ChatOverviewModelInput}. */
export interface ChatOverviewPanelProps {
  environmentId: EnvironmentId;
  activePlan: ActivePlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  threadSubagents: ReadonlyArray<ThreadSubagentView>;
  sourceControlActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
  branchControl: ReactNode;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  mode: "floating" | "sheet";
  /** Visible close affordance for overlay presentations (see PlanSidebar). */
  onClose?: (() => void) | undefined;
  onOpenFiles: () => void;
  onOpenReview: () => void;
  onOpenSubagent: (subagent: ThreadSubagentView) => void;
}

export function usePostPushWorkflowWatch() {
  const [postPushWorkflowWatch, setPostPushWorkflowWatch] =
    useState<PostPushWorkflowDiscoveryWatch | null>(null);

  const handlePostPush = useCallback((event: GitActionPostPushEvent) => {
    setPostPushWorkflowWatch(
      createPostPushWorkflowDiscoveryWatch({
        environmentId: event.environmentId,
        threadKey: event.threadKey,
        cwd: event.cwd,
        pullRequestNumber: event.pullRequestNumber,
        commitSha: event.commitSha,
        nowMs: Date.now(),
      }),
    );
    invalidateSourceControl({ environmentId: event.environmentId, cwd: event.cwd });
  }, []);

  useEffect(() => {
    if (!postPushWorkflowWatch) return;
    const timeoutId = window.setTimeout(
      () =>
        setPostPushWorkflowWatch((current) => (current === postPushWorkflowWatch ? null : current)),
      Math.max(0, postPushWorkflowWatch.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timeoutId);
  }, [postPushWorkflowWatch]);

  const clearWatch = useCallback(() => {
    setPostPushWorkflowWatch(null);
  }, []);

  return { postPushWorkflowWatch, handlePostPush, clearWatch } as const;
}

export interface OverviewPanelControlsInput {
  /**
   * "panel" renders the phone overview's full-width branch row and footer split
   * button; "rail" renders both as desktop overview rail items.
   */
  appearance: "panel" | "rail";
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  routeKind: "server" | "draft";
  draftId: DraftId | null;
  onPostPush: (event: GitActionPostPushEvent) => void;
  branchControlThread: { environmentId: EnvironmentId; id: ThreadId } | null;
  isGitRepo: boolean;
  canOverrideServerThreadBranch: boolean;
  activeThreadBranch: string | null;
  onActiveThreadBranchOverrideChange: (refName: string | null) => void;
  envLocked: boolean;
  onComposerFocusRequest: () => void;
  canCheckoutPullRequestIntoThread: boolean;
  onCheckoutPullRequestRequest: (reference: string) => void;
}

export interface OverviewPanelControls {
  sourceControlActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
  branchControl: ReactNode;
}

export function useOverviewPanelControls(input: OverviewPanelControlsInput): OverviewPanelControls {
  const {
    appearance,
    gitCwd,
    activeThreadRef,
    routeKind,
    draftId,
    onPostPush,
    branchControlThread,
    isGitRepo,
    canOverrideServerThreadBranch,
    activeThreadBranch,
    onActiveThreadBranchOverrideChange,
    envLocked,
    onComposerFocusRequest,
    canCheckoutPullRequestIntoThread,
    onCheckoutPullRequestRequest,
  } = input;

  const sourceControlActions = useCallback(
    (detectedChangeRequest: ChangeRequest | null) =>
      gitCwd && activeThreadRef ? (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadRef={activeThreadRef}
          detectedChangeRequest={detectedChangeRequest}
          {...(routeKind === "draft" && draftId ? { draftId } : {})}
          onPostPush={onPostPush}
          showLabels
          appearance={appearance === "rail" ? "rail" : "block"}
        />
      ) : null,
    [appearance, gitCwd, activeThreadRef, routeKind, draftId, onPostPush],
  );

  const branchControl = useMemo<ReactNode>(
    () =>
      branchControlThread && isGitRepo ? (
        <BranchToolbarBranchSelector
          {...(appearance === "rail"
            ? { appearance: "rail" as const }
            : { appearance: "panelRow" as const, className: "w-full" })}
          environmentId={branchControlThread.environmentId}
          threadId={branchControlThread.id}
          {...(routeKind === "draft" && draftId ? { draftId } : {})}
          {...(canOverrideServerThreadBranch
            ? {
                activeThreadBranchOverride: activeThreadBranch,
                onActiveThreadBranchOverrideChange,
              }
            : {})}
          envLocked={envLocked}
          onComposerFocusRequest={onComposerFocusRequest}
          {...(canCheckoutPullRequestIntoThread ? { onCheckoutPullRequestRequest } : {})}
        />
      ) : null,
    [
      appearance,
      branchControlThread,
      isGitRepo,
      routeKind,
      draftId,
      canOverrideServerThreadBranch,
      activeThreadBranch,
      onActiveThreadBranchOverrideChange,
      envLocked,
      onComposerFocusRequest,
      canCheckoutPullRequestIntoThread,
      onCheckoutPullRequestRequest,
    ],
  );

  return { sourceControlActions, branchControl };
}

export function ChatOverviewPanel(props: ChatOverviewPanelProps & ChatOverviewModelInput) {
  const {
    activePlan,
    sidebarProposedPlan,
    threadSubagents,
    sourceControlActions,
    branchControl,
    environmentId,
    markdownCwd,
    workspaceRoot,
    mode,
    onClose,
    onOpenFiles,
    onOpenReview,
    onOpenSubagent,
  } = props;
  const model = useChatOverviewModel(props);

  return (
    <PlanSidebar
      activePlan={activePlan}
      activeProposedPlan={sidebarProposedPlan}
      changes={model.changes}
      overviewItems={model.overviewItems}
      pullRequest={model.pullRequest}
      onRefreshPullRequest={model.onRefreshPullRequest}
      isRefreshingPullRequest={model.isRefreshingPullRequest}
      subagents={threadSubagents}
      sourceControlActions={sourceControlActions(model.detectedChangeRequest)}
      branchControl={branchControl}
      environmentId={environmentId}
      markdownCwd={markdownCwd}
      workspaceRoot={workspaceRoot}
      mode={mode}
      onClose={onClose}
      onOpenFiles={onOpenFiles}
      onOpenReview={onOpenReview}
      onOpenSubagent={onOpenSubagent}
    />
  );
}

export default ChatOverviewPanel;
