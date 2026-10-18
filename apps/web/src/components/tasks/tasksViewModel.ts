import type { LocalTaskLink, ProjectId, ThreadId } from "@ryco/contracts";

/**
 * The Tasks page's view model: everything the presentational components
 * render, already resolved from the node's tasks, the live thread store and
 * the node's projects. `TasksPage` builds it; the components never read a
 * store or call the node themselves, so the whole page can be rendered from
 * fixtures.
 */

/**
 * The word a task or chat shows for its chats; `null` on a task means it has
 * none. `failed` is a start that never got going; `error` a chat that ran and
 * then stopped on an error.
 */
export type TaskStatusWord =
  | "starting"
  | "running"
  | "needs-you"
  | "review"
  | "failed"
  | "error"
  | "unavailable";

export interface TaskProjectOption {
  readonly projectId: ProjectId;
  readonly name: string;
  /** The project's colour (its monogram colour), used for the dot. */
  readonly color: string;
}

export interface TaskChatView {
  /** Stable React key (the start's command id, or `thread:<id>` for a linked chat). */
  readonly key: string;
  readonly threadId: ThreadId;
  /** The chat's title, while this client knows the chat; a linked chat's chip and meta show it. */
  readonly title: string | null;
  /** The model's display name, e.g. "Opus 5.5". */
  readonly modelLabel: string;
  readonly status: TaskStatusWord;
  /** The branch or worktree the chat runs on; `null` when unknown. */
  readonly branch: string | null;
  /** A chat linked by hand rather than started from the task. */
  readonly linked: boolean;
  /** Why the start failed, when it did. */
  readonly error: string | null;
}

export type TaskWhereKind = "pr" | "branch" | "worktree" | "project";

/** One entry of the Start button's ▾ menu; a task's first option is the default. */
export interface TaskWhereOption {
  readonly id: string;
  readonly kind: TaskWhereKind;
  /** Menu title, e.g. "PR #746 worktree", "New worktree", "Project folder". */
  readonly label: string;
  /** Menu subtitle, e.g. "task/fix-login-redirect-loop from main". */
  readonly detail: string;
  /** The hint beside the button: `in ${hintPrefix} · <b>${hintRef}</b>`. */
  readonly hintPrefix: string;
  readonly hintRef: string | null;
}

export interface TaskFileView {
  /** Stable React key; the file id once stored, a local id while uploading. */
  readonly key: string;
  readonly name: string;
  readonly type: "image" | "file";
  /** 0..1 while uploading, `null` once stored. */
  readonly progress: number | null;
  readonly error: string | null;
}

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly done: boolean;
  readonly projectId: ProjectId | null;
  /** An ISO instant (the local midnight of the due day), or `null`. */
  readonly dueAt: string | null;
  readonly links: ReadonlyArray<LocalTaskLink>;
  readonly files: ReadonlyArray<TaskFileView>;
  readonly chats: ReadonlyArray<TaskChatView>;
  /** The most urgent chat's status; `null` when the task has no live chat. */
  readonly status: TaskStatusWord | null;
  readonly whereOptions: ReadonlyArray<TaskWhereOption>;
  /** A start is in flight; Start is disabled until it settles. */
  readonly starting: boolean;
  /** The project can no longer change: one of the task's starts may have a chat in it. */
  readonly projectLocked: boolean;
}

export interface TaskChatOption {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly subtitle: string;
}

export interface TasksViewModel {
  readonly openTasks: ReadonlyArray<TaskView>;
  readonly doneTasks: ReadonlyArray<TaskView>;
  /** Projects tasks can belong to, in sidebar order. */
  readonly projects: ReadonlyArray<TaskProjectOption>;
  /** Projects shown in the header filter after "All". */
  readonly filterProjects: ReadonlyArray<TaskProjectOption>;
  readonly filterProjectId: ProjectId | null;
  readonly expandedTaskId: string | null;
  readonly showDone: boolean;
  /** Local "now" in ms; due labels are relative to its calendar day. */
  readonly now: number;
  /** The list hasn't loaded yet. */
  readonly loading: boolean;
}

export interface TaskQuickAddInput {
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly dueAt: string | null;
}

export interface TasksViewHandlers {
  readonly onFilterChange: (projectId: ProjectId | null) => void;
  /** Adds tasks in order (one, or one per pasted line); `start` starts the single new task. */
  readonly onAdd: (inputs: ReadonlyArray<TaskQuickAddInput>, options: { start: boolean }) => void;
  readonly onToggleDone: (taskId: string, done: boolean) => void;
  readonly onToggleExpanded: (taskId: string) => void;
  readonly onToggleShowDone: () => void;
  readonly onTitleChange: (taskId: string, title: string) => void;
  readonly onNotesChange: (taskId: string, notes: string) => void;
  readonly onProjectChange: (taskId: string, projectId: ProjectId) => void;
  readonly onDueChange: (taskId: string, dueAt: string | null) => void;
  readonly onAddLink: (taskId: string, link: LocalTaskLink) => void;
  readonly onRemoveLink: (taskId: string, index: number) => void;
  readonly onAddFiles: (taskId: string, files: ReadonlyArray<File>) => void;
  readonly onRemoveFile: (taskId: string, fileKey: string) => void;
  /** Starts a chat; `whereId` is a `TaskWhereOption.id`, or the task's default when omitted. */
  readonly onStart: (taskId: string, whereId?: string) => void;
  readonly onOpenChat: (taskId: string, threadId: ThreadId) => void;
  readonly onDelete: (taskId: string) => void;
  /** Called when a row opens or the pointer enters Start, to warm the start path. */
  readonly onPrepareStart: (taskId: string) => void;
  /** Chats of the task's project that "Link → Existing chat" offers. */
  readonly getChatOptions: (taskId: string) => ReadonlyArray<TaskChatOption>;
}
