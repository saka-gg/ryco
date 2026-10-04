import { resolveThreadWorkspaceRoot } from "@ryco/client-runtime/state/files";
import type {
  Project,
  SidebarWorktreeSummary,
  Thread,
  ThreadInboxMutationBlocker,
} from "@ryco/client-runtime/state/threads";
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

export interface ThreadHeaderModel {
  readonly title: string;
  readonly nodeLabel: string;
  readonly projectLabel: string;
  readonly worktreeLabel: string;
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
    | "turnDiffSummaries"
    | "branch"
    | "worktreePath"
  >;
  readonly project: Pick<Project, "name" | "cwd"> | null;
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
}): ThreadHeaderModel {
  const running =
    input.thread.latestTurn?.state === "running" || input.thread.session?.status === "running";
  const nodeLabel = input.nodeLabel?.trim() || "Node";
  const projectLabel = input.project?.name.trim() || "Project";
  const worktreeLabel =
    input.worktree?.title?.trim() ||
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

  return {
    title: input.thread.title.trim() || "Untitled task",
    nodeLabel,
    projectLabel,
    worktreeLabel,
    statusLabel,
    contextAccessibilityLabel: `Working in node ${nodeLabel}, project ${projectLabel}, worktree ${worktreeLabel}. ${statusLabel}.`,
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
  };
}
