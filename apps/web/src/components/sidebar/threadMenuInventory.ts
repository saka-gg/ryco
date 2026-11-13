import {
  isWorkspaceDeleted,
  listThreadLifecycleActions,
  listWorkspaceLifecycleActions,
  type ThreadLifecycleSubject,
  type WorkspaceActionId,
  type WorkspaceLifecycleSubject,
} from "@ryco/client-runtime/state/lifecycle";

export type ThreadMenuActionId =
  | "open-in-split"
  | "pin"
  | "unpin"
  | "rename"
  | "mark-unread"
  | "project-settings"
  | "copy-project-path"
  | "copy-worktree-path"
  | "copy-path"
  | "copy-thread-id"
  | "interrupt-turn"
  | "stop-session"
  | "archive"
  | "unarchive"
  | "delete"
  | "discard-draft"
  | "workspace"
  | `workspace:${WorkspaceActionId}`
  | "workspace:manage"
  | "chat-reveal-folder"
  | "chat-open-folder-in-editor"
  | "chat-copy-folder-path"
  | `chat-extension:${string}`
  | typeof MOVE_TO_PROJECT_ACTION_ID
  | `${typeof MOVE_TO_PROJECT_ACTION_ID}:${string}`;

/** "Move to project" and its entries: `move-to-project:project:<id>`, `…:no-project`. */
export const MOVE_TO_PROJECT_ACTION_ID = "move-to-project";
const MOVE_TO_PROJECT_ENTRY_PREFIX = `${MOVE_TO_PROJECT_ACTION_ID}:project:`;
const MOVE_TO_NO_PROJECT_ID = `${MOVE_TO_PROJECT_ACTION_ID}:no-project` as const;

/** The target a "Move to project" entry names, or null for any other action. */
export function moveToProjectTargetOf(
  actionId: ThreadMenuActionId,
):
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "no-project" }
  | null {
  if (actionId === MOVE_TO_NO_PROJECT_ID) return { kind: "no-project" };
  if (actionId.startsWith(MOVE_TO_PROJECT_ENTRY_PREFIX)) {
    return { kind: "project", projectId: actionId.slice(MOVE_TO_PROJECT_ENTRY_PREFIX.length) };
  }
  return null;
}

export interface ThreadMenuActionItem {
  readonly id: ThreadMenuActionId;
  readonly label: string;
  readonly destructive?: boolean;
  /** Shown but not choosable; its label says why (DOM, native and phone presenters). */
  readonly disabled?: boolean;
  /** Rendered as a submenu (DOM, native and phone presenters all support nesting). */
  readonly children?: ReadonlyArray<ThreadMenuActionItem>;
}

export interface ThreadMenuInventoryInput {
  readonly thread: ThreadLifecycleSubject & { readonly worktreePath: string | null };
  readonly isDraft: boolean;
  readonly isPinned: boolean;
  readonly splitAvailable: boolean;
  /** Full project section (sidebar and Inbox) versus the plain "Copy Path" fallback. */
  readonly projectActions: { readonly memberProject: boolean } | null;
  /**
   * Inbox rows carry a Workspace submenu; the project sidebar already nests rows under
   * their workspace node, whose own menu offers the same workspace actions.
   */
  readonly workspace: {
    readonly record: WorkspaceLifecycleSubject | null;
    readonly protectedWorkspace: boolean;
  } | null;
  /**
   * A "No project" chat row: folder actions replace the project/worktree
   * section (a chat has no project settings or worktrees of its own).
   */
  readonly chat?: {
    /** The chat folder is on this machine, so it can be revealed or opened. */
    readonly localFolder: boolean;
    /** Label of the platform file manager ("Finder", "Explorer", "Files"). */
    readonly fileManagerLabel: string;
    readonly extensions: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  } | null;
  /**
   * "Move to project": the node's other projects by name, whether "No project" is offered (not
   * for a thread already in a chat), and why the thread cannot move now (null: it can).
   * Absent where the presenter does not offer moves.
   */
  readonly moveToProject?: {
    readonly targets: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    readonly offerNoProject: boolean;
    readonly blockedReason: string | null;
  } | null;
}

/**
 * The single thread action inventory, as data. Conversation lifecycle actions come
 * from the shared client-runtime inventory and stay separate from workspace actions,
 * which only ever appear inside the Workspace submenu.
 */
export function buildThreadMenuInventory(input: ThreadMenuInventoryInput): ThreadMenuActionItem[] {
  if (input.isDraft) return [{ id: "discard-draft", label: "Discard draft", destructive: true }];
  const items: ThreadMenuActionItem[] = [];
  if (input.splitAvailable) items.push({ id: "open-in-split", label: "Open in split view" });
  const chat = input.chat ?? null;
  items.push(
    input.isPinned ? { id: "unpin", label: "Unpin thread" } : { id: "pin", label: "Pin thread" },
    { id: "rename", label: chat ? "Rename chat" : "Rename thread" },
    { id: "mark-unread", label: "Mark unread" },
  );
  if (chat) {
    if (chat.localFolder) {
      items.push(
        { id: "chat-reveal-folder", label: `Show folder in ${chat.fileManagerLabel}` },
        { id: "chat-open-folder-in-editor", label: "Open folder in editor" },
      );
    }
    items.push({ id: "chat-copy-folder-path", label: "Copy folder path" });
    for (const extension of chat.extensions) {
      items.push({ id: `chat-extension:${extension.id}`, label: extension.label });
    }
  } else if (input.projectActions) {
    if (input.projectActions.memberProject)
      items.push(
        { id: "project-settings", label: "Project settings" },
        { id: "copy-project-path", label: "Copy Project Path" },
      );
    if (input.thread.worktreePath)
      items.push({ id: "copy-worktree-path", label: "Copy Worktree Path" });
  } else {
    items.push({ id: "copy-path", label: "Copy Path" });
  }
  items.push({ id: "copy-thread-id", label: "Copy Thread ID" });
  const move = input.moveToProject ?? null;
  if (move)
    items.push({
      id: MOVE_TO_PROJECT_ACTION_ID,
      label: "Move to project",
      children: moveToProjectEntries(move),
    });
  // A chat folder is not a Git workspace, and a deleted workspace is gone.
  if (
    input.workspace &&
    !chat &&
    !(input.workspace.record && isWorkspaceDeleted(input.workspace.record))
  ) {
    const workspaceItems: ThreadMenuActionItem[] = input.workspace.record
      ? listWorkspaceLifecycleActions(input.workspace.record, {
          protectedWorkspace: input.workspace.protectedWorkspace,
        }).map((item): ThreadMenuActionItem =>
          item.destructive
            ? { id: `workspace:${item.action}`, label: item.label, destructive: true }
            : { id: `workspace:${item.action}`, label: item.label },
        )
      : [];
    items.push({
      id: "workspace",
      label: "Workspace",
      children: [...workspaceItems, { id: "workspace:manage", label: "Manage workspaces…" }],
    });
  }
  for (const action of listThreadLifecycleActions(input.thread)) {
    items.push({
      id: action.id,
      label: action.label,
      ...(action.destructive ? { destructive: true } : {}),
    });
  }
  return items;
}

function moveToProjectEntries(
  move: NonNullable<ThreadMenuInventoryInput["moveToProject"]>,
): ThreadMenuActionItem[] {
  if (move.blockedReason !== null) {
    return [
      { id: `${MOVE_TO_PROJECT_ACTION_ID}:blocked`, label: move.blockedReason, disabled: true },
    ];
  }
  const entries: ThreadMenuActionItem[] = move.targets.map((target) => ({
    id: `${MOVE_TO_PROJECT_ENTRY_PREFIX}${target.id}`,
    label: target.name,
  }));
  if (move.offerNoProject) entries.push({ id: MOVE_TO_NO_PROJECT_ID, label: "No project" });
  return entries.length > 0
    ? entries
    : [{ id: `${MOVE_TO_PROJECT_ACTION_ID}:none`, label: "No other projects", disabled: true }];
}

/** Flattened lookup of every actionable id in an inventory, including submenu entries. */
export function threadMenuActionIds(
  items: ReadonlyArray<ThreadMenuActionItem>,
): ThreadMenuActionId[] {
  return items.flatMap((item) => (item.children ? threadMenuActionIds(item.children) : [item.id]));
}
