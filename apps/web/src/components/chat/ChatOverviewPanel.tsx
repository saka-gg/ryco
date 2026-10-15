import type { ChangeRequest, EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { useCallback, useMemo, type ReactNode } from "react";
import { useGitActionNotice } from "~/gitActionNotices";
import { useGitActionActivity } from "~/rpc/useGit";
import PlanSidebar from "../PlanSidebar";
import type { DraftId } from "../../composerDraftStore";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import GitActionsControl, {
  GitThreadSync,
  type GitActionPostPushEvent,
  type GitActionsControlAppearance,
} from "../GitActionsControl";
import { CrownOverview } from "../overview/crown/CrownOverview";
import type { CrownOverviewProps } from "../overview/crown/crownTypes";
import { useWorktreeNotes, type WorktreeNotesTarget } from "../overview/notes/useWorktreeNotes";
import { type ChatProjectTarget, usePromoteChatBinding } from "./ChatProjectActions";
import type { PostPushWorkflowDiscoveryWatch } from "../postPushWorkflowDiscovery.logic";
import { type ChatOverviewModelInput, useChatOverviewModel } from "./useChatOverviewModel";

/** Crown-only inputs; the classic phone sheet does not render them. */
export type ChatOverviewCrownInput = Pick<
  CrownOverviewProps,
  | "threadTitle"
  | "isGitRepo"
  | "latestTurn"
  | "turnSettled"
  | "agentRunning"
  | "project"
  | "isChat"
  | "pullRequestLinking"
> & {
  /** Drives the rail's enter / exit transition while ChatView delays unmount. */
  open: boolean;
  /** What the thread's worktree notes are written against; null hides Notes. */
  notesTarget: WorktreeNotesTarget | null;
  /**
   * The thread's "No project" chat, which the rail offers to turn into a
   * project in place of its source-control sections; null for projects.
   */
  chatProject: ChatProjectTarget | null;
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
  /** The same controls as explicit Commit / Push / PR / Pull buttons (the crown's branch preview). */
  sourceControlQuickActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
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

  const renderSourceControl = useCallback(
    (appearance: GitActionsControlAppearance, detectedChangeRequest: ChangeRequest | null) =>
      gitCwd && activeThreadRef ? (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadRef={activeThreadRef}
          detectedChangeRequest={detectedChangeRequest}
          {...(routeKind === "draft" && draftId ? { draftId } : {})}
          onPostPush={onPostPush}
          showLabels
          appearance={appearance}
        />
      ) : null,
    [gitCwd, activeThreadRef, routeKind, draftId, onPostPush],
  );
  const sourceControlActions = useCallback(
    (detectedChangeRequest: ChangeRequest | null) =>
      renderSourceControl("block", detectedChangeRequest),
    [renderSourceControl],
  );
  const sourceControlQuickActions = useCallback(
    (detectedChangeRequest: ChangeRequest | null) =>
      renderSourceControl("actions", detectedChangeRequest),
    [renderSourceControl],
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

  return { sourceControlActions, sourceControlQuickActions, branchControl, sourceControlSync };
}

type ChatOverviewPanelElementProps = ChatOverviewPanelProps & {
  postPushWorkflowWatch: PostPushWorkflowDiscoveryWatch | null;
  onPostPushDiscoveryComplete: () => void;
};

/**
 * Resolves the thread's overview model once and hands it to a presenter: the
 * Crown rail on desktop, or the classic panel inside the phone sheet.
 */
export function ChatOverviewPanel(props: ChatOverviewPanelElementProps) {
  const { layoutProps, readiness } = useChatOverviewModel(props);
  const userGitActionActive = useGitActionActivity(props.environmentId, props.gitCwd);
  // The open crown reports this checkout's git actions in place of toasts.
  const gitNotice = useGitActionNotice(
    props.environmentId,
    props.gitCwd,
    props.presentation !== "sheet" && props.open,
  );

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
        chatProject={props.chatProject}
        {...layoutProps}
        preview={props.preview}
        threadTitle={props.threadTitle}
        project={props.project ?? null}
        isChat={props.isChat}
        pullRequestLinking={props.pullRequestLinking}
        readiness={readiness}
        isGitRepo={props.isGitRepo}
        latestTurn={props.latestTurn}
        turnSettled={props.turnSettled}
        agentRunning={props.agentRunning}
        open={props.open}
        scopeKey={`${props.activeThreadKey ?? "none"}|${props.gitCwd ?? ""}`}
        userGitActionActive={userGitActionActive}
        gitNotice={gitNotice}
      />
    </>
  );
}

/** What ChatView hands the on-demand overview panel. */
export type ChatOverviewPanelWithControlsProps = DistributiveOmit<
  ChatOverviewPanelElementProps,
  "sourceControlActions" | "sourceControlQuickActions" | "branchControl" | "sourceControlSync"
> & {
  /** The thread's git controls, built here so ChatView stays free of them. */
  controls: OverviewPanelControlsInput;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The overview panel with its git controls. ChatView loads this module on
 * demand (see `chatOverviewPanelModule`), so the overview, crown, plan sidebar
 * and git action controls stay out of the chat route's first-frame graph.
 */
export function ChatOverviewPanelWithControls({
  controls,
  ...props
}: ChatOverviewPanelWithControlsProps) {
  const { sourceControlActions, sourceControlQuickActions, branchControl, sourceControlSync } =
    useOverviewPanelControls(controls);
  return props.presentation === "crown" ? (
    <ChatOverviewPanel
      {...props}
      sourceControlActions={sourceControlActions}
      sourceControlQuickActions={sourceControlQuickActions}
      branchControl={branchControl}
      sourceControlSync={sourceControlSync}
    />
  ) : (
    <ChatOverviewPanel
      {...props}
      sourceControlActions={sourceControlActions}
      branchControl={branchControl}
      sourceControlSync={sourceControlSync}
    />
  );
}

/** The crown bound to the thread's notes and chat; the phone sheet never reads them. */
function CrownWithNotes({
  notesTarget,
  chatProject,
  ...props
}: Omit<CrownOverviewProps, "notes" | "chat"> & {
  readonly open: boolean;
  readonly notesTarget: WorktreeNotesTarget | null;
  readonly chatProject: ChatProjectTarget | null;
}) {
  const notes = useWorktreeNotes(notesTarget);
  const chat = usePromoteChatBinding(chatProject);
  return <CrownOverview {...props} notes={notes} chat={chat} />;
}

export default ChatOverviewPanel;
