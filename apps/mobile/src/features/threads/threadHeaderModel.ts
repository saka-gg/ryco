import {
  CHAT_WORKSPACE_LABEL,
  describeNativeCompactionBlocker,
  nativeCompactionAdvertised,
  nativeCompactionBlockerForSession,
  projectDisplayLabel,
} from "@ryco/client-runtime/state/composer";
import { resolveThreadWorkspaceRoot } from "@ryco/client-runtime/state/files";
import {
  findPullRequestWatch,
  pullRequestWatchView,
  type Project,
  type PullRequestWatchTarget,
  type PullRequestWatchTone,
  type SidebarWorktreeSummary,
  type Thread,
  type ThreadInboxMutationBlocker,
} from "@ryco/client-runtime/state/threads";
import type { ThreadPullRequestWatchShell } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import type { ThreadSettlementBlocker } from "@ryco/shared/threadSettlement";

import { buildChangeRequestBadge, type ChangeRequestBadge } from "../../lib/changeRequestBadge";

/**
 * Worktree matching lives in client-runtime so the file browser can resolve a
 * workspace root without depending on the thread header. Re-exported here to
 * keep the existing import sites intact.
 */
export { findThreadWorktree } from "@ryco/client-runtime/state/files";

export type ThreadMoreAction = "rename" | "archive" | "unarchive" | "stop" | "details";

export interface ThreadSettlementActionModel {
  readonly kind: "settle" | "unsettle";
  readonly label: "Settle task" | "Move to Active";
  readonly detail: string;
  readonly disabled: boolean;
}

/** The compact chip beside the change-request badge while a watch is on. */
export interface ThreadPullRequestWatchChip {
  /**
   * "Watching", "Auto-fix on", "Fixing 2/3", "Auto-fix paused"; "#77 Watching" when the
   * watched pull request is not the one the badge beside it names.
   */
  readonly label: string;
  /** Muted while the thread is cached: the watch's state is then last known, not live. */
  readonly tone: PullRequestWatchTone;
  /** The whole status, spoken: the chip itself is a word or two. */
  readonly accessibilityLabel: string;
}

/**
 * The node's server-side watch of the thread's pull request (Auto-fix CI and
 * the news wakes), as the header and the task sheet show it.
 */
export interface ThreadHeaderPullRequestWatch {
  /**
   * The pull request the sheet's controls act on: the one the thread watches
   * (its workspace's first, then one of another workspace in the project), else
   * its workspace's current one.
   */
  readonly target: PullRequestWatchTarget;
  /** A watch may start: the pull request is open as last known and the chat is active. */
  readonly startable: boolean;
  /**
   * The watched pull request is another workspace's (a delegated chat's, say): Auto-fix CI
   * runs only in the chat's own checkout, so the switch is not offered there.
   */
  readonly otherWorkspace: boolean;
  /** The thread's watches as its shell carries them (active, and ended within a day). */
  readonly watches: ThreadPullRequestWatchShell | null;
  readonly chip: ThreadPullRequestWatchChip | null;
}

/** Compact now, as web's context meter offers it: the provider summarizes older context. */
export interface ThreadCompactActionModel {
  readonly label: "Compact conversation";
  /** Why it cannot run now, or what it does when it can. */
  readonly detail: string;
  readonly disabled: boolean;
}

export interface ThreadHeaderModel {
  readonly title: string;
  readonly nodeLabel: string;
  readonly projectLabel: string;
  readonly worktreeLabel: string;
  /** Heading over `projectLabel · worktreeLabel`; a chat works in a folder, not a worktree. */
  readonly contextHeading: "Project · Worktree" | "Project · Folder";
  readonly statusLabel:
    | "Ready"
    | "Running"
    | "Needs approval"
    | "Input needed"
    | "Archived"
    | "Offline";
  readonly contextAccessibilityLabel: string;
  readonly reviewVisible: boolean;
  /**
   * Whether the file browser has a directory to list. A thread whose worktree,
   * own path and project checkout are all unknown has nothing to browse, so the
   * action is withheld rather than opening onto an empty screen.
   */
  readonly filesVisible: boolean;
  readonly moreActions: ReadonlyArray<ThreadMoreAction>;
  /** Last known pull request / work item for the thread's worktree, if any. */
  readonly changeRequest: ChangeRequestBadge | null;
  readonly settlementAction: ThreadSettlementActionModel | null;
  /** Null on nodes without pull request watches, and when there is no pull request. */
  readonly pullRequestWatch: ThreadHeaderPullRequestWatch | null;
  /**
   * Null unless the thread's session belongs to a provider that compacts on request and its
   * latest context usage says it can (for Claude, that its CLI lists `/compact`).
   */
  readonly compactAction: ThreadCompactActionModel | null;
}

function compactAction(
  thread: Pick<Thread, "session" | "activities">,
): ThreadCompactActionModel | null {
  // The thread's session, not the composer's selection: after a handoff they differ.
  const blocker = nativeCompactionBlockerForSession(thread.session);
  if (blocker === "unsupported" || !nativeCompactionAdvertised(thread.activities)) return null;
  return {
    label: "Compact conversation",
    detail:
      blocker === null
        ? "Summarize older context. The summary request itself uses tokens."
        : describeNativeCompactionBlocker(blocker),
    disabled: blocker !== null,
  };
}

function settlementDisabledReason(input: {
  readonly mutationEnabled: boolean;
  readonly mutationBlocker: ThreadInboxMutationBlocker | null;
  readonly canSettle: boolean;
  readonly settlementBlocker: ThreadSettlementBlocker | null;
}): string | null {
  if (!input.mutationEnabled) {
    switch (input.mutationBlocker) {
      case "unsupported":
        return "Update this machine before changing attention state.";
      case "disconnected":
        return "Reconnect this machine to change attention state.";
      case "read-only":
        return "This machine is read-only.";
      case "shell-stale":
        return "Waiting for the latest task list from this machine.";
      case "client-draft":
        return "Send the first message before settling this task.";
      case null:
        return "This task cannot be changed right now.";
    }
  }
  if (input.canSettle) return null;
  switch (input.settlementBlocker) {
    case "pending-approval":
      return "Resolve the pending approval first.";
    case "pending-user-input":
      return "Answer the pending question first.";
    case "session-starting":
    case "session-running":
      return "Wait for the agent to finish.";
    case "queued-turn":
    case "local-queue":
      return "Send or remove queued work first.";
    case "delivery-unknown":
      // Reconnecting cannot confirm it; the thread's delivery notice clears it.
      return "Check the unconfirmed action on this machine first.";
    case "unsupported":
      return "Update this machine before settling tasks.";
    case "thread-archived":
    case "thread-deleted":
    case "worktree-archived":
      return "Archived work is managed separately.";
    case null:
      return "This task cannot be settled right now.";
  }
}

type WatchWorktree = Pick<SidebarWorktreeSummary, "prNumber" | "prState" | "pullRequests"> | null;

function buildPullRequestWatch(input: {
  readonly available: boolean;
  readonly watches: ThreadPullRequestWatchShell | null;
  readonly worktree: WatchWorktree;
  /** The thread's own workspace, when it records one. */
  readonly threadWorktreeId: string | null;
  /** The node takes a new watch on this thread (the server refuses archived and settled ones). */
  readonly threadActive: boolean;
  /** The thread is cached (`forcedOffline`): the shell's watch state is last known. */
  readonly stale: boolean;
}): ThreadHeaderPullRequestWatch | null {
  if (!input.available) return null;
  const active = input.watches?.active ?? [];
  const prNumber = input.worktree?.prNumber ?? null;
  const watched =
    (prNumber === null ? undefined : active.find((watch) => watch.number === prNumber)) ??
    active[0];
  const target: PullRequestWatchTarget | null = watched
    ? { number: watched.number, url: watched.url }
    : prNumber === null
      ? null
      : {
          number: prNumber,
          url:
            input.worktree?.pullRequests?.find(
              (link) => link.number === prNumber && !link.dismissedAt,
            )?.url ?? null,
        };
  if (target === null) return null;
  const prState = watched ? "open" : (input.worktree?.prState ?? null);
  const found = findPullRequestWatch(input.watches, target);
  const view = found?.kind === "active" ? pullRequestWatchView(found.watch) : null;
  return {
    target,
    startable: input.threadActive && prState !== "merged" && prState !== "closed",
    otherWorkspace:
      watched !== undefined &&
      input.threadWorktreeId !== null &&
      watched.worktreeId !== input.threadWorktreeId,
    watches: input.watches,
    chip: view
      ? {
          // The badge beside the chip names the workspace's pull request; a watch of another
          // one (a delegated chat's) says which it is.
          label:
            target.number === prNumber ? view.shortLabel : `#${target.number} ${view.shortLabel}`,
          tone: input.stale ? "muted" : view.tone,
          accessibilityLabel: `Pull request ${target.number}: ${view.label}.${
            view.detail ? ` ${view.detail}.` : ""
          }${input.stale ? " Last known." : ""}`,
        }
      : null,
  };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function buildThreadHeaderModel(input: {
  readonly thread: Pick<
    Thread,
    | "title"
    | "archivedAt"
    | "latestTurn"
    | "session"
    | "activities"
    | "turnDiffSummaries"
    | "branch"
    | "worktreePath"
    | "settledOverride"
    | "worktreeId"
  >;
  readonly project: Pick<Project, "name" | "cwd" | "kind"> | null;
  readonly worktree: Pick<
    SidebarWorktreeSummary,
    | "title"
    | "branch"
    | "worktreePath"
    | "prNumber"
    | "prState"
    | "prIsDraft"
    | "issueNumber"
    | "issueState"
    | "workItemKey"
    | "workItemState"
    | "workItemStateName"
    | "pullRequests"
  > | null;
  readonly nodeLabel: string | null;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  /**
   * The thread's content is cache provenance, so none of the status this model
   * would otherwise derive is live. Same precedence the inbox uses for a stale
   * environment's rows (`inboxModel.ts` `threadState`): staleness outranks
   * every cached field, because a snapshot captured mid-turn keeps claiming
   * "Running" long after the node stopped answering.
   */
  readonly forcedOffline?: boolean;
  readonly settlement?:
    | {
        readonly attentionState: "active" | "settled";
        readonly canSettle: boolean;
        readonly settlementBlocker: ThreadSettlementBlocker | null;
        readonly mutationEnabled: boolean;
        readonly mutationBlocker: ThreadInboxMutationBlocker | null;
      }
    | undefined;
  /** Absent: the node's config has not said yet, which shows nothing. */
  readonly pullRequestWatch?:
    | {
        /** The node watches pull requests (`ServerConfig.pullRequestWatch.available`). */
        readonly available: boolean;
        /** The thread's watches from its shell (absent when it has none). */
        readonly watches: ThreadPullRequestWatchShell | null | undefined;
      }
    | undefined;
}): ThreadHeaderModel {
  const running =
    input.thread.latestTurn?.state === "running" || input.thread.session?.status === "running";
  const nodeLabel = input.nodeLabel?.trim() || "Node";
  // A "No project" chat is an ordinary thread in one plain folder: no project name, no branch.
  const isChat = isChatProject(input.project);
  const projectLabel = projectDisplayLabel(input.project, "Project");
  const worktreeLabel = isChat
    ? CHAT_WORKSPACE_LABEL
    : input.worktree?.title?.trim() ||
      input.worktree?.branch.trim() ||
      input.thread.branch?.trim() ||
      (input.thread.worktreePath ? basename(input.thread.worktreePath) : "Local workspace");
  const statusLabel = input.forcedOffline
    ? "Offline"
    : input.thread.archivedAt !== null
      ? "Archived"
      : input.hasPendingApproval
        ? "Needs approval"
        : input.hasPendingUserInput
          ? "Input needed"
          : running
            ? "Running"
            : "Ready";
  const moreActions: ThreadMoreAction[] = ["rename"];
  if (running) moreActions.push("stop");
  moreActions.push(input.thread.archivedAt === null ? "archive" : "unarchive", "details");
  const settlementDisabled = input.settlement ? settlementDisabledReason(input.settlement) : null;
  const settlementAction =
    input.thread.archivedAt !== null || !input.settlement
      ? null
      : input.settlement.attentionState === "settled"
        ? {
            kind: "unsettle" as const,
            label: "Move to Active" as const,
            detail: settlementDisabled ?? "Return this task to your active attention queue.",
            disabled: settlementDisabled !== null,
          }
        : {
            kind: "settle" as const,
            label: "Settle task" as const,
            detail: settlementDisabled ?? "Mark this task handled without archiving it.",
            disabled: settlementDisabled !== null,
          };

  const pullRequestWatch = buildPullRequestWatch({
    available: input.pullRequestWatch?.available ?? false,
    watches: input.pullRequestWatch?.watches ?? null,
    worktree: input.worktree,
    threadWorktreeId: input.thread.worktreeId ?? null,
    threadActive: input.thread.archivedAt === null && input.thread.settledOverride !== "settled",
    stale: input.forcedOffline === true,
  });
  const contextAccessibilityLabel = isChat
    ? `Working in node ${nodeLabel}, ${projectLabel}, in a chat folder. ${statusLabel}.`
    : `Working in node ${nodeLabel}, project ${projectLabel}, worktree ${worktreeLabel}. ${statusLabel}.`;

  return {
    title: input.thread.title.trim() || "Untitled task",
    nodeLabel,
    projectLabel,
    worktreeLabel,
    contextHeading: isChat ? "Project · Folder" : "Project · Worktree",
    statusLabel,
    // The context bar is one button, so a screen reader reaches nothing inside it: the
    // watch chip's status is spoken here.
    contextAccessibilityLabel: pullRequestWatch?.chip
      ? `${contextAccessibilityLabel} ${pullRequestWatch.chip.accessibilityLabel}`
      : contextAccessibilityLabel,
    reviewVisible: input.thread.turnDiffSummaries.some((summary) => summary.files.length > 0),
    filesVisible:
      resolveThreadWorkspaceRoot({
        thread: input.thread,
        worktree: input.worktree,
        project: input.project,
      }) !== null,
    moreActions,
    changeRequest: buildChangeRequestBadge(input.worktree),
    settlementAction,
    pullRequestWatch,
    compactAction: compactAction(input.thread),
  };
}
