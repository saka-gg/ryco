import {
  describeTaskLink,
  listTaskChats,
  taskLinkKey,
  taskLinkLabelIn,
  type LocalTaskThreadSummaryReader,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import type { LocalTaskLink, ProjectId, ThreadId } from "@ryco/contracts";

import { TASK_CHAT_WORDS, type TaskChatWord, type TaskChipKind } from "./tasksListModel";

// The task sheet's rows, pure so they are testable: the task's chats with
// their live state, its links with what tapping one opens, and the chats of
// its project it can link to.

/** What the sheet reads of a machine's chat. */
export interface TaskThreadInfo {
  readonly id: ThreadId;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
  readonly updatedAt?: string | undefined;
  readonly createdAt?: string | undefined;
}

export interface TaskChatRow {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly title: string;
  /** "Needs you", "Running"…; "Gone" for a chat this phone cannot see any more. */
  readonly word: string;
  readonly tone: TaskChatWord | "gone";
  readonly branch: string | null;
  readonly linked: boolean;
  readonly error: string | null;
  /** The chat is there to open. */
  readonly openable: boolean;
}

export function taskChatRows(
  task: LocalTaskView,
  getSummary: LocalTaskThreadSummaryReader,
  readThread: (threadId: ThreadId) => TaskThreadInfo | undefined,
): ReadonlyArray<TaskChatRow> {
  return listTaskChats(task, getSummary).map((chat, index) => {
    const thread = readThread(chat.threadId);
    const gone = chat.status === "unavailable";
    return {
      key: chat.key,
      threadId: chat.threadId,
      title: thread?.title ?? (chat.linked ? "Linked chat" : `Chat ${index + 1}`),
      word: gone ? "Gone" : TASK_CHAT_WORDS[chat.status as TaskChatWord],
      tone: gone ? "gone" : (chat.status as TaskChatWord),
      branch: chat.branch,
      linked: chat.linked,
      error: chat.startFailed ? chat.error : null,
      openable: thread !== undefined,
    };
  });
}

export type TaskLinkTarget =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | null;

export interface TaskLinkRow {
  readonly key: string;
  readonly index: number;
  readonly kind: TaskChipKind | "thread";
  /** "#746", "OPS-42", the branch, the chat's title, a short URL. */
  readonly label: string;
  /** "Pull request #746", or the title the link was made with. */
  readonly detail: string;
  readonly target: TaskLinkTarget;
}

export function taskLinkRows(
  links: ReadonlyArray<LocalTaskLink>,
  readThread: (threadId: ThreadId) => TaskThreadInfo | undefined,
): ReadonlyArray<TaskLinkRow> {
  const chats = links.flatMap((link) => {
    if (link.kind !== "thread") return [];
    const thread = readThread(link.threadId);
    return thread ? [{ threadId: link.threadId as string, title: thread.title }] : [];
  });
  return links.map((link, index) => {
    const titled = "title" in link && link.title ? link.title : null;
    const url = "url" in link && link.url ? link.url : null;
    return {
      key: `${taskLinkKey(link)}#${index}`,
      index,
      kind: link.kind === "thread" ? "thread" : link.kind,
      label: taskLinkLabelIn(link, chats),
      detail: titled ?? describeTaskLink(link),
      target:
        link.kind === "thread"
          ? readThread(link.threadId)
            ? { kind: "thread", threadId: link.threadId }
            : null
          : url
            ? { kind: "url", url }
            : null,
    };
  });
}

/** At most this many recent chats are offered to link. */
export const LINKABLE_CHAT_LIMIT = 12;

/**
 * The chats "Link a chat" offers: the task's project's live chats (any
 * project's when the task has none), most recently active first, without the
 * ones the task already has.
 */
export function linkableTaskChats(
  task: Pick<LocalTaskView, "projectId" | "links" | "delegations">,
  threads: Iterable<TaskThreadInfo>,
): ReadonlyArray<TaskThreadInfo> {
  const taken = new Set<string>([
    ...task.delegations.map((delegation) => delegation.threadId as string),
    ...task.links.flatMap((link) => (link.kind === "thread" ? [link.threadId as string] : [])),
  ]);
  const candidates: TaskThreadInfo[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null || taken.has(thread.id)) continue;
    if (task.projectId !== null && thread.projectId !== task.projectId) continue;
    candidates.push(thread);
  }
  const activity = (thread: TaskThreadInfo) => thread.updatedAt ?? thread.createdAt ?? "";
  return candidates
    .toSorted((left, right) => (activity(left) < activity(right) ? 1 : -1))
    .slice(0, LINKABLE_CHAT_LIMIT);
}

/**
 * The title to save from the field: trimmed and on one line; null when it
 * says nothing new (unchanged, or blank, which the node refuses).
 */
export function titleToSave(typed: string, current: string): string | null {
  const title = typed.replace(/\s+/g, " ").trim();
  return title.length === 0 || title === current ? null : title;
}
