import type { ChangeRequest, EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useGitActionActivity } from "~/rpc/useGit";
import { invalidateSourceControl } from "~/rpc/useSourceControl";
import PlanSidebar from "../PlanSidebar";
import type { DraftId } from "../../composerDraftStore";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import GitActionsControl, {
  GitThreadSync,
  type GitActionPostPushEvent,
} from "../GitActionsControl";
import { CrownOverview } from "../overview/crown/CrownOverview";
import type { CrownOverviewProps } from "../overview/crown/crownTypes";
import { useWorktreeNotes, type WorktreeNotesTarget } from "../overview/notes/useWorktreeNotes";
import {
  createPostPushWorkflowDiscoveryWatch,
  type PostPushWorkflowDiscoveryWatch,
} from "../postPushWorkflowDiscovery.logic";
import { type ChatOverviewModelInput, useChatOverviewModel } from "./useChatOverviewModel";

/** Crown-only inputs; the classic phone sheet does not render them. */
export type ChatOverviewCrownInput = Pick<
  CrownOverviewProps,
  "threadTitle" | "isGitRepo" | "latestTurn" | "turnSettled" | "agentRunning"
> & {
  /** Drives the rail's enter / exit transition while ChatView delays unmount. */
  open: boolean;
  /** What the thread's worktree notes are written against; null hides Notes. */
  notesTarget: WorktreeNotesTarget | null;
  /** Opens a note's backlinked thread in the notes' environment. */
  onOpenNoteThread?: ((threadId: ThreadId) => void) | undefined;
};

export type ChatOverviewPanelProps = Omit<
  ChatOverviewModelInput,
  "postPushWorkflowWatch" | "onPostPushDiscoveryComplete"
> & {
  /** Computer-beta / background-browser previews (local environment only). */
  preview?: ReactNode;
  /** The git controls' background work ({@link GitThreadSync}), mounted while the overview is. */
  sourceControlSync?: ReactNode;
} & (
    | {
        /** The frozen web phone tier's full-screen classic panel. */
        presentation: "sheet";
      }
    | ({
        /** The desktop Crown rail. */
        presentation: "crown";
      } & ChatOverviewCrownInput)
  );

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
  /** Keeps the thread in step with its checkout whether or not the controls are shown. */
  sourceControlSync: ReactNode;
}

export function useOverviewPanelControls(input: OverviewPanelControlsInput): OverviewPanelControls {
  const {
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
          block
        />
      ) : null,
    [gitCwd, activeThreadRef, routeKind, draftId, onPostPush],
  );

  const sourceControlSync = useMemo<ReactNode>(
    () =>
      gitCwd && activeThreadRef ? (
        <GitThreadSync
          gitCwd={gitCwd}
          activeThreadRef={activeThreadRef}
          {...(routeKind === "draft" && draftId ? { draftId } : {})}
        />
      ) : null,
    [gitCwd, activeThreadRef, routeKind, draftId],
  );

  const branchControl = useMemo<ReactNode>(
    () =>
      branchControlThread && isGitRepo ? (
        <BranchToolbarBranchSelector
          appearance="panelRow"
          className="w-full"
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

  return { sourceControlActions, branchControl, sourceControlSync };
}

/**
 * Resolves the thread's overview model once and hands it to a presenter: the
 * Crown rail on desktop, or the classic panel inside the phone sheet.
 */
export function ChatOverviewPanel(
  props: ChatOverviewPanelProps & {
    postPushWorkflowWatch: PostPushWorkflowDiscoveryWatch | null;
    onPostPushDiscoveryComplete: () => void;
  },
) {
  const { layoutProps, readiness } = useChatOverviewModel(props);
  const userGitActionActive = useGitActionActivity(props.environmentId, props.gitCwd);

  if (props.presentation === "sheet") {
    return (
      <>
        {props.sourceControlSync}
        <PlanSidebar {...layoutProps} preview={props.preview} mode="sheet" />
      </>
    );
  }

  return (
    <>
      {props.sourceControlSync}
      <CrownWithNotes
        notesTarget={props.notesTarget}
        onOpenNoteThread={props.onOpenNoteThread}
        {...layoutProps}
        preview={props.preview}
        threadTitle={props.threadTitle}
        readiness={readiness}
        isGitRepo={props.isGitRepo}
        latestTurn={props.latestTurn}
        turnSettled={props.turnSettled}
        agentRunning={props.agentRunning}
        open={props.open}
        scopeKey={`${props.activeThreadKey ?? "none"}|${props.gitCwd ?? ""}`}
        userGitActionActive={userGitActionActive}
      />
    </>
  );
}

/** The crown bound to the thread's notes; the phone sheet never reads them. */
function CrownWithNotes({
  notesTarget,
  onOpenNoteThread,
  ...props
}: Omit<CrownOverviewProps, "notes"> & {
  readonly open: boolean;
  readonly notesTarget: WorktreeNotesTarget | null;
  readonly onOpenNoteThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const notes = useWorktreeNotes(notesTarget, { onOpenThread: onOpenNoteThread });
  return <CrownOverview {...props} notes={notes} />;
}

export default ChatOverviewPanel;
