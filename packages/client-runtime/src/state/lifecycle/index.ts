import type { WorkspaceLifecycleAction } from "@ryco/contracts";

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
  | "trash";

export interface ThreadLifecycleActionItem {
  readonly id: ThreadLifecycleActionId;
  readonly label: string;
  readonly destructive?: boolean;
}

export interface ThreadLifecycleSubject {
  readonly archivedAt: string | null;
  readonly latestUserMessageAt?: string | null | undefined;
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
  thread: ThreadLifecycleSubject,
): ThreadLifecycleActionItem[] {
  const items: ThreadLifecycleActionItem[] = [];
  if (isThreadTurnRunning(thread)) items.push({ id: "interrupt-turn", label: "Interrupt turn" });
  else if (isThreadSessionLive(thread)) items.push({ id: "stop-session", label: "Stop session" });
  if (thread.archivedAt !== null) items.push({ id: "unarchive", label: "Unarchive thread" });
  else if (thread.latestUserMessageAt) items.push({ id: "archive", label: "Archive thread" });
  items.push({ id: "trash", label: "Move to Trash", destructive: true });
  return items;
}

export interface WorkspaceLifecycleSubject {
  readonly archivedAt: string | null;
  readonly checkoutRemovedAt?: string | null | undefined;
}

export interface WorkspaceLifecycleActionItem {
  readonly action: WorkspaceLifecycleAction;
  readonly label: string;
  /** Opens the exact-effects review before anything changes. */
  readonly review: boolean;
  readonly destructive?: boolean;
}

/**
 * Menu inventory without filesystem inspection. "Remove checkout" also covers a
 * checkout that turns out to be missing: its review shows the stale-record effect.
 * The project root/main checkout and derived groups never get lifecycle actions.
 */
export function listWorkspaceLifecycleActions(
  workspace: WorkspaceLifecycleSubject,
  options: { readonly protectedWorkspace: boolean },
): WorkspaceLifecycleActionItem[] {
  if (options.protectedWorkspace) return [];
  const removed = workspace.checkoutRemovedAt != null;
  const items: WorkspaceLifecycleActionItem[] = [];
  if (workspace.archivedAt === null)
    items.push({ action: "archive", label: "Archive workspace", review: false });
  else items.push({ action: "restore", label: "Restore workspace", review: false });
  if (removed)
    items.push({ action: "recreate-checkout", label: "Recreate checkout…", review: true });
  else
    items.push({
      action: "remove-checkout",
      label: "Remove checkout…",
      review: true,
      destructive: true,
    });
  return items;
}

/** Labels for every action, including those only offered after inspection. */
export const WORKSPACE_LIFECYCLE_ACTION_LABELS: Readonly<Record<WorkspaceLifecycleAction, string>> =
  {
    archive: "Archive workspace",
    restore: "Restore workspace",
    "remove-checkout": "Remove checkout",
    "remove-stale-record": "Remove stale workspace record",
    "recreate-checkout": "Recreate checkout",
  };

/** Retention copy shown wherever archived or trashed conversations are listed. */
export const LIFECYCLE_RETENTION_COPY = {
  archive: "Archived conversations are kept indefinitely. Unarchive them at any time.",
  trash:
    "Conversations in Trash keep their history, attachments and terminal history. Ryco never empties Trash automatically; items stay until you delete them permanently.",
  permanentDelete:
    "Deleting permanently removes this conversation, its attachments and its terminal history. This cannot be undone.",
} as const;
