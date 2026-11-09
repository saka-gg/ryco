import type { ThreadHeaderModel } from "./threadHeaderModel";

/**
 * The thread header's one ⋯ menu: everything the old header buttons (Review, Files, Terminal)
 * and the old "Task details" sheet offered, as a native menu in three inline groups (iOS; Android
 * menus have no inline groups, so there it is one list: `flattenThreadHeaderMenu`). The title
 * pill opens the context sheet for what is read rather than done (machine, project, branch,
 * status, cache, delegated chats).
 */
export type ThreadHeaderMenuActionId =
  | "files"
  | "find-in-files"
  | "terminal"
  | "scripts"
  | "servers"
  | "device"
  | "devices"
  | "source-control"
  | "notes"
  | "more-tools"
  | "review"
  | "pull-request"
  | "side-chat"
  | "fork"
  | "rename"
  | "turn-into-project"
  | "add-task"
  | "copy-reference"
  | "copy-task-id"
  | "stop"
  | "stop-session"
  | "compact"
  | "settlement"
  | "archive"
  | "delete";

export interface ThreadHeaderMenuAction {
  readonly id: ThreadHeaderMenuActionId;
  readonly title: string;
  /** An SF Symbol name. */
  readonly icon: string;
  readonly subtitle?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** A submenu's items ("More tools"); its own id is never run. */
  readonly children?: ReadonlyArray<ThreadHeaderMenuAction>;
}

export interface ThreadHeaderMenuSection {
  readonly id: "workspace" | "chat" | "state";
  readonly actions: ReadonlyArray<ThreadHeaderMenuAction>;
}

export interface ThreadHeaderMenuInput {
  readonly model: ThreadHeaderModel;
  /** The thread's project has a checkout the source-control screen reads. */
  readonly sourceControlAvailable: boolean;
  /** The Terminal item's note: "Command running · 2 sessions", or null. */
  readonly terminalSubtitle?: string | null;
  /** A simulator or emulator is attached to the thread. */
  readonly deviceAvailable: boolean;
  /** The workspace tools the node and the thread can run; each shows only when true. */
  readonly tools?: {
    readonly findInFiles: boolean;
    readonly scripts: boolean;
    readonly servers: boolean;
    readonly notes: boolean;
    readonly devices: boolean;
  };
  /** The composer has a model a side question could ask. */
  readonly sideChatAvailable: boolean;
  /** A reply can be forked right now (the latest forkable one). */
  readonly forkAvailable: boolean;
  /** The thread is loaded, so a task can link to it ("Add to Tasks"). */
  readonly addTaskAvailable: boolean;
  /** The thread is a chat without a project, which can become one ("Turn into project"). */
  readonly promoteChatAvailable?: boolean;
  /**
   * No turn runs but the provider session is still up (`listThreadLifecycleActions`): Stop
   * session ends it and keeps the conversation.
   */
  readonly sessionStoppable?: boolean;
  /** A rename, stop, archive and the like cannot be sent now (busy, cached or offline). */
  readonly busy: boolean;
}

/** The workspace group's longest inline list; past it the extra tools collapse into one submenu. */
export const WORKSPACE_GROUP_MAX = 7;

export function buildThreadHeaderMenu(
  input: ThreadHeaderMenuInput,
): ReadonlyArray<ThreadHeaderMenuSection> {
  const { model, busy } = input;
  const workspace: ThreadHeaderMenuAction[] = [];
  if (model.filesVisible) workspace.push({ id: "files", title: "Files", icon: "folder" });
  if (model.terminalVisible) {
    workspace.push({
      id: "terminal",
      title: "Terminal",
      icon: "apple.terminal",
      ...(input.terminalSubtitle ? { subtitle: input.terminalSubtitle } : {}),
    });
  }
  if (input.deviceAvailable) workspace.push({ id: "device", title: "Device", icon: "iphone" });
  if (input.sourceControlAvailable) {
    workspace.push({
      id: "source-control",
      title: "Source control",
      icon: "arrow.triangle.branch",
    });
  }
  if (model.reviewVisible) {
    workspace.push({
      id: "review",
      title: "Review changes",
      icon: "doc.text.magnifyingglass",
      disabled: busy,
    });
  }
  if (model.pullRequestNumber !== null) {
    workspace.push({
      id: "pull-request",
      title: `Pull request #${model.pullRequestNumber}`,
      icon: "arrow.triangle.pull",
    });
  }

  // The less frequent tools join the group while it stays short, else sit behind "More tools".
  const tools: ThreadHeaderMenuAction[] = [];
  if (input.tools?.findInFiles) {
    tools.push({ id: "find-in-files", title: "Find in files", icon: "text.magnifyingglass" });
  }
  if (input.tools?.scripts) tools.push({ id: "scripts", title: "Run script", icon: "play" });
  if (input.tools?.servers) {
    tools.push({ id: "servers", title: "Servers & preview", icon: "safari" });
  }
  if (input.tools?.notes) tools.push({ id: "notes", title: "Notes", icon: "note.text" });
  if (input.tools?.devices) {
    tools.push({ id: "devices", title: "Simulators", icon: "iphone.gen3" });
  }
  if (workspace.length + tools.length <= WORKSPACE_GROUP_MAX) workspace.push(...tools);
  else if (tools.length > 0) {
    workspace.push({
      id: "more-tools",
      title: "More tools",
      icon: "ellipsis.circle",
      children: tools,
    });
  }

  const chat: ThreadHeaderMenuAction[] = [];
  if (input.sideChatAvailable) {
    chat.push({ id: "side-chat", title: "Side chat", icon: "bubble.left.and.bubble.right" });
  }
  if (input.forkAvailable) {
    chat.push({ id: "fork", title: "Fork from latest reply", icon: "arrow.triangle.branch" });
  }
  chat.push({ id: "rename", title: "Rename…", icon: "pencil", disabled: busy });
  if (input.promoteChatAvailable) {
    chat.push({
      id: "turn-into-project",
      title: "Turn into project…",
      icon: "folder.badge.plus",
      disabled: busy,
    });
  }
  if (input.addTaskAvailable) {
    chat.push({ id: "add-task", title: "Add to Tasks", icon: "checklist" });
  }
  chat.push(
    model.copyReference.kind === "pull-request"
      ? { id: "copy-reference", title: "Copy pull request link", icon: "link" }
      : { id: "copy-reference", title: "Copy task ID", icon: "doc.on.doc" },
  );
  if (model.copyReference.kind === "pull-request") {
    chat.push({ id: "copy-task-id", title: "Copy task ID", icon: "doc.on.doc" });
  }

  const state: ThreadHeaderMenuAction[] = [];
  const turnRunning = model.moreActions.includes("stop");
  if (turnRunning) {
    state.push({
      id: "stop",
      title: "Stop current turn",
      icon: "stop.circle",
      destructive: true,
      disabled: busy,
    });
  }
  if (!turnRunning && input.sessionStoppable) {
    state.push({ id: "stop-session", title: "Stop session", icon: "power", disabled: busy });
  }
  if (model.compactAction) {
    state.push({
      id: "compact",
      title: model.compactAction.label,
      icon: "arrow.down.right.and.arrow.up.left",
      // Why it can't run; what it does is in its name.
      ...(model.compactAction.disabled ? { subtitle: model.compactAction.detail } : {}),
      disabled: busy || model.compactAction.disabled,
    });
  }
  if (model.settlementAction) {
    state.push({
      id: "settlement",
      title: model.settlementAction.label,
      icon: model.settlementAction.kind === "settle" ? "checkmark.circle" : "arrow.uturn.backward",
      ...(model.settlementAction.disabled ? { subtitle: model.settlementAction.detail } : {}),
      disabled: busy || model.settlementAction.disabled,
    });
  }
  const archive = model.moreActions.includes("archive");
  state.push({
    id: "archive",
    title: archive ? "Archive" : "Restore",
    icon: archive ? "archivebox" : "arrow.uturn.backward",
    ...(turnRunning ? { subtitle: "Stop the current turn first." } : {}),
    destructive: archive,
    disabled: busy || turnRunning,
  });
  state.push({ id: "delete", title: "Delete…", icon: "trash", destructive: true, disabled: busy });

  const sections: ThreadHeaderMenuSection[] = [];
  if (workspace.length > 0) sections.push({ id: "workspace", actions: workspace });
  sections.push({ id: "chat", actions: chat });
  sections.push({ id: "state", actions: state });
  return sections;
}

/**
 * The menu as one list, for Android. `@react-native-menu/menu` ignores `displayInline` there and
 * turns every group into a submenu, which with an empty title reads as a blank row; Android's
 * popup menu has no inline groups to begin with, so the groups are concatenated in order. "More
 * tools" stays one titled submenu.
 */
export function flattenThreadHeaderMenu(
  sections: ReadonlyArray<ThreadHeaderMenuSection>,
): ReadonlyArray<ThreadHeaderMenuAction> {
  return sections.flatMap((section) => section.actions);
}

/** The title a rename saves: trimmed, or null when it is empty or unchanged (nothing to send). */
export function resolveThreadRename(current: string, value: string | undefined): string | null {
  const title = value?.trim() ?? "";
  return title.length === 0 || title === current ? null : title;
}
