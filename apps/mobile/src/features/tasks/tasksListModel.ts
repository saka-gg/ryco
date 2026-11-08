import {
  compareDoneTasks,
  dueDayDiff,
  dueLabel,
  isDueSoon,
  listTaskChats,
  taskDueBucket,
  taskLinkLabel,
  type LocalTaskChat,
  type LocalTaskThreadSummaryReader,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import type {
  LocalTaskDelegationStatus,
  LocalTaskLink,
  ProjectId,
  ThreadId,
} from "@ryco/contracts";

// The phone's Tasks list, pure so it is testable without a renderer: which
// section a task sits in, how its row reads (priority, due day, project, link
// chips, its chats' state) and what its trailing button does. The task rules
// themselves (due days, links, chat status) are client-runtime's, shared with
// the web Tasks page.

export type TaskSectionKey = "today" | "upcoming" | "none" | "done";

export const TASK_SECTION_TITLES: Readonly<Record<TaskSectionKey, string>> = {
  today: "Today",
  upcoming: "Upcoming",
  none: "No date",
  done: "Done",
};

export type TaskPriority = LocalTaskView["priority"];

/** Most pressing first, for sorting and the priority mark. */
const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** Overdue reads red, due within two days amber, later days plain. */
export type TaskDueTone = "overdue" | "soon" | "later";

export type TaskChipKind = "pr" | "issue" | "workItem" | "branch" | "url" | "chats" | "files";

export interface TaskChipModel {
  readonly key: string;
  readonly kind: TaskChipKind;
  readonly label: string;
}

/** The word a task's live chats show, most urgent chat first. */
export type TaskChatWord = Exclude<LocalTaskDelegationStatus, "unavailable">;

export const TASK_CHAT_WORDS: Readonly<Record<TaskChatWord, string>> = {
  "needs-you": "Needs you",
  starting: "Starting",
  running: "Running",
  failed: "Failed",
  review: "Ready",
};

/** What the row's trailing button does: open the task's chat, or start its first one. */
export type TaskChatAction =
  | { readonly kind: "open"; readonly threadId: ThreadId }
  | { readonly kind: "start" }
  | null;

export interface TaskRowModel {
  readonly taskId: string;
  readonly title: string;
  readonly done: boolean;
  readonly priority: TaskPriority;
  /** `urgent` and `high` show a mark beside the title; the others none. */
  readonly priorityMark: "urgent" | "high" | null;
  readonly dueAt: string | null;
  /** "Today", "Fri", "Oct 24", "Overdue"; null without a due date. */
  readonly dueLabel: string | null;
  readonly dueTone: TaskDueTone | null;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
  /** "ryco · due today": the project, then the due day. */
  readonly meta: string | null;
  readonly chips: ReadonlyArray<TaskChipModel>;
  readonly chatWord: TaskChatWord | null;
  readonly chatAction: TaskChatAction;
  /** Created or changed here; the node has not confirmed it yet. */
  readonly pending: boolean;
}

export interface TaskSectionModel {
  readonly key: TaskSectionKey;
  readonly title: string;
  readonly count: number;
  readonly rows: ReadonlyArray<TaskRowModel>;
}

/** At most this many completed tasks show until the section is expanded. */
export const DONE_PREVIEW_COUNT = 3;

const CHAT_URGENCY: Readonly<Record<LocalTaskDelegationStatus, number>> = {
  "needs-you": 0,
  running: 1,
  starting: 2,
  review: 3,
  failed: 4,
  unavailable: 5,
};

/** The chats a task can still open, most urgent first (the latest of a kind first). */
export function openableTaskChats(chats: ReadonlyArray<LocalTaskChat>): LocalTaskChat[] {
  return chats
    .map((chat, index) => ({ chat, index }))
    .filter(({ chat }) => chat.status !== "unavailable")
    .toSorted(
      (left, right) =>
        CHAT_URGENCY[left.chat.status] - CHAT_URGENCY[right.chat.status] ||
        right.index - left.index,
    )
    .map(({ chat }) => chat);
}

function linkChip(link: LocalTaskLink): TaskChipModel | null {
  switch (link.kind) {
    case "pr":
      return { key: `pr:${link.number}`, kind: "pr", label: `PR #${link.number}` };
    case "issue":
      return { key: `issue:${link.number}`, kind: "issue", label: `Issue #${link.number}` };
    case "workItem":
      return { key: `workItem:${link.key}`, kind: "workItem", label: link.key };
    case "branch":
      return { key: `branch:${link.name}`, kind: "branch", label: link.name };
    case "url":
      return { key: `url:${link.url}`, kind: "url", label: taskLinkLabel(link) };
    case "thread":
      // Linked chats count into the chats chip.
      return null;
  }
}

/** The row's chips: its links in order, then how many chats and files it has. */
export function taskChips(
  task: Pick<LocalTaskView, "links" | "files">,
  chats: ReadonlyArray<LocalTaskChat>,
): ReadonlyArray<TaskChipModel> {
  const chips: TaskChipModel[] = [];
  const seen = new Set<string>();
  for (const link of task.links) {
    const chip = linkChip(link);
    if (chip === null || seen.has(chip.key)) continue;
    seen.add(chip.key);
    chips.push(chip);
  }
  const chatCount = openableTaskChats(chats).length;
  if (chatCount > 0)
    chips.push({
      key: "chats",
      kind: "chats",
      label: chatCount === 1 ? "1 chat" : `${chatCount} chats`,
    });
  if (task.files.length > 0)
    chips.push({
      key: "files",
      kind: "files",
      label: task.files.length === 1 ? "1 file" : `${task.files.length} files`,
    });
  return chips;
}

export function taskDueTone(dueAt: string, nowMs: number): TaskDueTone {
  const diff = dueDayDiff(dueAt, nowMs);
  if (diff !== null && diff < 0) return "overdue";
  return isDueSoon(dueAt, nowMs) ? "soon" : "later";
}

/** "due today", "due Fri", "overdue": the due day as the meta line says it. */
function dueMeta(label: string): string {
  return label === "Overdue"
    ? "overdue"
    : `due ${label === "Today" || label === "Tomorrow" ? label.toLowerCase() : label}`;
}

export interface TaskRowContext {
  readonly nowMs: number;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly getSummary: LocalTaskThreadSummaryReader;
  /** Whether a chat can be started at all (the machine has a project to start it in). */
  readonly canStart: boolean;
}

export function buildTaskRow(task: LocalTaskView, context: TaskRowContext): TaskRowModel {
  const done = task.state === "done";
  const chats = listTaskChats(task, context.getSummary);
  const openable = openableTaskChats(chats);
  const label = task.dueAt === null ? null : dueLabel(task.dueAt, context.nowMs);
  const projectName =
    task.projectId === null ? null : (context.projectNames.get(task.projectId) ?? null);
  const metaParts = [projectName, label === null || done ? null : dueMeta(label)].filter(
    (part): part is string => part !== null,
  );
  const first = openable[0];
  const chatAction: TaskChatAction = done
    ? null
    : first
      ? { kind: "open", threadId: first.threadId }
      : context.canStart
        ? { kind: "start" }
        : null;
  return {
    taskId: task.taskId,
    title: task.title,
    done,
    priority: task.priority,
    priorityMark: task.priority === "urgent" || task.priority === "high" ? task.priority : null,
    dueAt: task.dueAt,
    dueLabel: label,
    dueTone: task.dueAt === null || label === null ? null : taskDueTone(task.dueAt, context.nowMs),
    projectId: task.projectId,
    projectName,
    meta: metaParts.length > 0 ? metaParts.join(" · ") : null,
    chips: taskChips(task, chats),
    chatWord: done || !first ? null : (first.status as TaskChatWord),
    chatAction,
    pending: task.creating || task.saving,
  };
}

function dueMs(task: Pick<LocalTaskView, "dueAt">): number {
  const ms = task.dueAt === null ? Number.NaN : Date.parse(task.dueAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Open tasks: earliest due day first, then the more pressing, then the newest. */
export function compareOpenTaskRows(left: LocalTaskView, right: LocalTaskView): number {
  return (
    dueMs(left) - dueMs(right) ||
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
    (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0) ||
    (left.taskId < right.taskId ? 1 : left.taskId > right.taskId ? -1 : 0)
  );
}

/** Whether a task matches the in-list search: its title, notes or links. */
export function taskMatchesQuery(task: LocalTaskView, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    task.title,
    task.notes,
    ...task.links.map((link) => {
      switch (link.kind) {
        case "pr":
        case "issue":
          return `#${link.number} ${link.title ?? ""}`;
        case "workItem":
          return `${link.key} ${link.title ?? ""}`;
        case "branch":
          return link.name;
        case "url":
          return `${link.label ?? ""} ${link.url}`;
        case "thread":
          return "";
      }
    }),
  ]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface TaskListFilter {
  /** One project's tasks; null for all. */
  readonly projectId: ProjectId | null;
  readonly query: string;
}

/**
 * The list's sections in order: Today (overdue included), Upcoming, No date,
 * then Done. An empty open section is left out; Done shows while it has any.
 */
export function buildTaskSections(
  tasks: ReadonlyArray<LocalTaskView>,
  filter: TaskListFilter,
  context: TaskRowContext,
): ReadonlyArray<TaskSectionModel> {
  const buckets: Record<TaskSectionKey, LocalTaskView[]> = {
    today: [],
    upcoming: [],
    none: [],
    done: [],
  };
  for (const task of tasks) {
    if (filter.projectId !== null && task.projectId !== filter.projectId) continue;
    if (!taskMatchesQuery(task, filter.query)) continue;
    if (task.state === "done") buckets.done.push(task);
    else buckets[taskDueBucket(task.dueAt, context.nowMs)].push(task);
  }
  const sections: TaskSectionModel[] = [];
  for (const key of ["today", "upcoming", "none", "done"] as const) {
    const list = buckets[key];
    if (list.length === 0) continue;
    list.sort(key === "done" ? compareDoneTasks : compareOpenTaskRows);
    // Start sits on what is due now; later tasks start from their sheet, which keeps the list calm.
    const rowContext = key === "today" ? context : { ...context, canStart: false };
    sections.push({
      key,
      title: TASK_SECTION_TITLES[key],
      count: list.length,
      rows: list.map((task) => buildTaskRow(task, rowContext)),
    });
  }
  return sections;
}

/** How many open tasks are due today or overdue: the tab's badge. */
export function countTasksDueToday(tasks: ReadonlyArray<LocalTaskView>, nowMs: number): number {
  let count = 0;
  for (const task of tasks)
    if (task.state !== "done" && taskDueBucket(task.dueAt, nowMs) === "today") count += 1;
  return count;
}
