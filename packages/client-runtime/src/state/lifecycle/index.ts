import type {
  WorkspaceCheckoutState,
  WorkspaceLifecycleRequest,
  WorktreeCheckoutRemovalReason,
} from "@ryco/contracts";
import { threadHasConversation } from "@ryco/shared/threadFork";

import { isArchivedThreadStub, type ArchivedThreadStub } from "../threads/types.ts";

/**
 * The lifecycle action inventory shared by every client surface (sidebar, Inbox,
 * workspace management; web, desktop and mobile). Conversation and workspace actions
 * are separate lists so a surface can never blur them into one "close" action.
 */
export type ThreadLifecycleActionId =
  | "interrupt-turn"
  | "stop-session"
  | "archive"
  | "unarchive"
  | "delete";

export interface ThreadLifecycleActionItem {
  readonly id: ThreadLifecycleActionId;
  readonly label: string;
  readonly destructive?: boolean;
}

export interface ThreadLifecycleSubject {
  readonly archivedAt: string | null;
  readonly latestUserMessageAt?: string | null | undefined;
  /** A fork holds its inherited conversation before it sends anything (`threadHasConversation`). */
  readonly lineage?: { readonly relationship: string } | null | undefined;
  readonly session: {
    readonly status: string;
    readonly activeTurnId?: string | null | undefined;
  } | null;
  readonly latestTurn: { readonly state: string } | null;
}

export const isThreadTurnRunning = (thread: ThreadLifecycleSubject): boolean =>
  thread.session?.status === "running" ||
  thread.session?.activeTurnId != null ||
  thread.latestTurn?.state === "running";

/** A provider runtime is attached; stopping it keeps the conversation and its terminals' history. */
export const isThreadSessionLive = (thread: ThreadLifecycleSubject): boolean =>
  thread.session !== null &&
  thread.session.status !== "stopped" &&
  thread.session.status !== "error";

export function listThreadLifecycleActions(
  thread: ThreadLifecycleSubject | ArchivedThreadStub,
): ThreadLifecycleActionItem[] {
  // A stub knows of no session or turn to stop; its full shell, once loaded, does.
  if (isArchivedThreadStub(thread)) {
    return [
      { id: "unarchive", label: "Unarchive thread" },
      { id: "delete", label: "Delete…", destructive: true },
    ];
  }
  const items: ThreadLifecycleActionItem[] = [];
  if (isThreadTurnRunning(thread)) items.push({ id: "interrupt-turn", label: "Interrupt turn" });
  else if (isThreadSessionLive(thread)) items.push({ id: "stop-session", label: "Stop session" });
  if (thread.archivedAt !== null) items.push({ id: "unarchive", label: "Unarchive thread" });
  else if (threadHasConversation(thread)) items.push({ id: "archive", label: "Archive thread" });
  items.push({ id: "delete", label: "Delete…", destructive: true });
  return items;
}

/**
 * Every workspace action a surface offers. A workspace gets exactly three:
 * Archive (hide it; nothing on disk changes), Restore (show it again; the node
 * recreates a removed checkout whose branch still exists) and "Delete
 * workspace" (one reviewed removal of the checkout, its branch and,
 * optionally, its conversations). The contract's other actions
 * (`remove-checkout`, `remove-stale-record`, `recreate-checkout`) stay for
 * Agent Control and older clients; no surface offers them.
 */
export type WorkspaceActionId = "archive" | "restore" | "delete-workspace";

export const WORKSPACE_LIFECYCLE_ACTION_LABELS: Readonly<Record<WorkspaceActionId, string>> = {
  archive: "Archive workspace",
  restore: "Restore workspace",
  "delete-workspace": "Delete workspace",
};

/**
 * Whether an action changes a checkout on disk, so it runs only after the
 * exact-effects review. Exhaustive: a new action must be classified.
 */
const WORKSPACE_ACTION_NEEDS_REVIEW: Readonly<Record<WorkspaceActionId, boolean>> = {
  archive: false,
  restore: false,
  "delete-workspace": true,
};

/** A workspace action that is reviewed before it runs. */
export type WorkspaceReviewAction = "delete-workspace";

export function isWorkspaceReviewAction(
  action: WorkspaceActionId,
): action is WorkspaceReviewAction {
  return WORKSPACE_ACTION_NEEDS_REVIEW[action];
}

export const WORKSPACE_REVIEW_ACTIONS: readonly WorkspaceReviewAction[] = (
  Object.keys(WORKSPACE_ACTION_NEEDS_REVIEW) as WorkspaceActionId[]
).filter(isWorkspaceReviewAction);

/**
 * The review a `review` link names. Links from older builds named the checkout
 * removals; those open the delete review (which shows its exact effects before
 * anything changes). A recreate link names nothing any more: Restore recreates.
 */
export function parseWorkspaceReviewAction(raw: unknown): WorkspaceReviewAction | null {
  switch (raw) {
    case "delete-workspace":
    case "remove-checkout":
    case "remove-stale-record":
      return "delete-workspace";
    default:
      return null;
  }
}

/**
 * The lifecycle request an action makes. "Delete workspace" is a discarding
 * checkout removal that always deletes the branch; its conversations are kept
 * (archived) unless the reader also deletes them.
 */
export function workspaceActionRequest(
  action: WorkspaceActionId,
  options: { readonly deleteConversations?: boolean } = {},
): Omit<WorkspaceLifecycleRequest, "worktreeId"> {
  return action === "delete-workspace"
    ? {
        action: "remove-checkout",
        discard: true,
        deleteBranch: true,
        deleteConversations: options.deleteConversations === true,
      }
    : { action, discard: false };
}

/**
 * A workspace the user deleted while keeping its conversations: the record
 * stays only as their provenance. Every surface hides it.
 */
export const isWorkspaceDeleted = (worktree: {
  readonly checkoutRemovalReason?: WorktreeCheckoutRemovalReason | null | undefined;
}): boolean => worktree.checkoutRemovalReason === "deleted";

export interface WorkspaceLifecycleSubject {
  readonly archivedAt: string | null;
  readonly checkoutRemovedAt?: string | null | undefined;
  readonly checkoutRemovalReason?: WorktreeCheckoutRemovalReason | null | undefined;
  /** What an inspection found on disk, when there is one: a missing checkout restores. */
  readonly checkout?: WorkspaceCheckoutState | null | undefined;
}

export interface WorkspaceLifecycleActionItem {
  readonly action: WorkspaceActionId;
  readonly label: string;
  /** Opens the exact-effects review before anything changes. */
  readonly review: boolean;
  readonly destructive?: boolean;
}

/**
 * Menu inventory without filesystem inspection: Archive while the workspace is
 * live, Restore once it is archived or its checkout is gone, and always
 * "Delete workspace…" (its review says what it would discard or why it cannot
 * run). The project root/main checkout, derived groups and deleted workspaces
 * never get lifecycle actions.
 */
export function listWorkspaceLifecycleActions(
  workspace: WorkspaceLifecycleSubject,
  options: { readonly protectedWorkspace: boolean },
): WorkspaceLifecycleActionItem[] {
  if (options.protectedWorkspace || isWorkspaceDeleted(workspace)) return [];
  const restorable =
    workspace.archivedAt !== null ||
    workspace.checkoutRemovedAt != null ||
    workspace.checkout === "removed" ||
    workspace.checkout === "missing";
  const primary: WorkspaceActionId = restorable ? "restore" : "archive";
  return [
    {
      action: primary,
      label: WORKSPACE_LIFECYCLE_ACTION_LABELS[primary],
      review: isWorkspaceReviewAction(primary),
    },
    {
      action: "delete-workspace",
      label: `${WORKSPACE_LIFECYCLE_ACTION_LABELS["delete-workspace"]}…`,
      review: isWorkspaceReviewAction("delete-workspace"),
      destructive: true,
    },
  ];
}

/** Retention copy shown wherever archived conversations are listed or deleted. */
export const LIFECYCLE_RETENTION_COPY = {
  archive: "Archived conversations are kept indefinitely. Unarchive them at any time.",
  permanentDelete:
    "Deleting removes a conversation, its attachments and its terminal history. You can undo for a few seconds; after that it's gone for good.",
} as const;
