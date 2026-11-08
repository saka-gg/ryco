import type { ThreadHeaderModel } from "./threadHeaderModel";

/**
 * The thread header's one ⋯ menu: everything the old header buttons (Review, Files, Terminal)
 * and the old "Task details" sheet offered, as a native menu in three inline groups. The title
 * pill opens the context sheet for what is read rather than done (machine, project, branch,
 * status, cache, delegated chats).
 */
export type ThreadHeaderMenuActionId =
  | "files"
  | "terminal"
  | "device"
  | "source-control"
  | "review"
  | "pull-request"
  | "side-chat"
  | "fork"
  | "rename"
  | "add-task"
  | "copy-reference"
  | "copy-task-id"
  | "stop"
  | "compact"
  | "settlement"
  | "archive";

export interface ThreadHeaderMenuAction {
  readonly id: ThreadHeaderMenuActionId;
  readonly title: string;
  /** An SF Symbol name. */
  readonly icon: string;
  readonly subtitle?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

export interface ThreadHeaderMenuSection {
  readonly id: "workspace" | "chat" | "state";
  readonly actions: ReadonlyArray<ThreadHeaderMenuAction>;
}

export interface ThreadHeaderMenuInput {
  readonly model: ThreadHeaderModel;
  /** The thread's project has a checkout the source-control screen reads. */
  readonly sourceControlAvailable: boolean;
  /** A simulator or emulator is attached to the thread. */
  readonly deviceAvailable: boolean;
  /** The composer has a model a side question could ask. */
  readonly sideChatAvailable: boolean;
  /** A reply can be forked right now (the latest forkable one). */
  readonly forkAvailable: boolean;
  /** The thread is loaded, so a task can link to it ("Add to Tasks"). */
  readonly addTaskAvailable: boolean;
  /** A rename, stop, archive and the like cannot be sent now (busy, cached or offline). */
  readonly busy: boolean;
}

export function buildThreadHeaderMenu(
  input: ThreadHeaderMenuInput,
): ReadonlyArray<ThreadHeaderMenuSection> {
  const { model, busy } = input;
  const workspace: ThreadHeaderMenuAction[] = [];
  if (model.filesVisible) workspace.push({ id: "files", title: "Files", icon: "folder" });
  if (model.terminalVisible) {
    workspace.push({ id: "terminal", title: "Terminal", icon: "apple.terminal" });
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

  const chat: ThreadHeaderMenuAction[] = [];
  if (input.sideChatAvailable) {
    chat.push({ id: "side-chat", title: "Side chat", icon: "bubble.left.and.bubble.right" });
  }
  if (input.forkAvailable) {
    chat.push({ id: "fork", title: "Fork from latest reply", icon: "arrow.triangle.branch" });
  }
  chat.push({ id: "rename", title: "Rename…", icon: "pencil", disabled: busy });
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

  const sections: ThreadHeaderMenuSection[] = [];
  if (workspace.length > 0) sections.push({ id: "workspace", actions: workspace });
  sections.push({ id: "chat", actions: chat });
  sections.push({ id: "state", actions: state });
  return sections;
}
