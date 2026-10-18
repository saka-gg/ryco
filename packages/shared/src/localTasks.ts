import type {
  LocalTaskDelegationStatus,
  LocalTaskLink,
  ThreadId,
  WorkItemProviderKind,
} from "@ryco/contracts";

import { formatThreadMentionPath, isThreadMentionableId } from "./threadMentions.ts";

/** A task's status while it is open, worked out from the chats started for it. */
export type LocalTaskChatAggregate = "todo" | Exclude<LocalTaskDelegationStatus, "unavailable">;

/**
 * Most urgent first: a chat waiting on the user outranks one still starting,
 * which outranks one working, then a failed start, then a finished chat.
 */
export const LOCAL_TASK_STATUS_ORDER: ReadonlyArray<Exclude<LocalTaskChatAggregate, "todo">> = [
  "needs-you",
  "starting",
  "running",
  "failed",
  "review",
];

/**
 * The status an open task shows for its chats. Chats that are gone
 * (`unavailable`) say nothing about the task, so a task whose chats are all
 * gone reads as `todo` again. Server and clients share this so the word on a
 * row never disagrees with the node's own `status`.
 */
export function aggregateLocalTaskStatus(
  statuses: Iterable<LocalTaskDelegationStatus>,
): LocalTaskChatAggregate {
  let best: LocalTaskChatAggregate = "todo";
  let bestRank = LOCAL_TASK_STATUS_ORDER.length;
  for (const status of statuses) {
    if (status === "unavailable") continue;
    const rank = LOCAL_TASK_STATUS_ORDER.indexOf(status);
    if (rank !== -1 && rank < bestRank) {
      best = status;
      bestRank = rank;
    }
  }
  return best;
}

const WORK_ITEM_PROVIDER_LABELS: Record<WorkItemProviderKind, string> = { jira: "Jira" };

export interface TaskStartPromptInput {
  readonly title: string;
  readonly notes: string;
  readonly links: ReadonlyArray<LocalTaskLink>;
  /** Words written after a linked chat's mention, e.g. its title. */
  readonly describeThread?: (threadId: ThreadId) => string | null | undefined;
}

function withUrl(text: string, url: string | undefined): string {
  return url ? `${text} ${url}` : text;
}

/** "Pull request #746: Fix the login loop" when the link kept a title. */
function withTitle(label: string, title: string | undefined): string {
  return title ? `${label}: ${title}` : label;
}

function describeTaskLink(
  link: LocalTaskLink,
  describeThread: TaskStartPromptInput["describeThread"],
): string {
  switch (link.kind) {
    case "pr":
      return withUrl(withTitle(`Pull request #${link.number}`, link.title), link.url);
    case "issue":
      return withUrl(withTitle(`Issue #${link.number}`, link.title), link.url);
    case "workItem":
      return withUrl(
        withTitle(`${WORK_ITEM_PROVIDER_LABELS[link.provider]} ${link.key}`, link.title),
        link.url,
      );
    case "branch":
      return `Branch ${link.name}`;
    case "thread": {
      // The mention token becomes one of the message's `threadReferences`,
      // so the node hands the agent an excerpt of that chat.
      const mention = isThreadMentionableId(link.threadId)
        ? `@${formatThreadMentionPath(link.threadId)}`
        : `Chat ${link.threadId}`;
      const description = describeThread?.(link.threadId)?.replace(/\s+/g, " ").trim();
      return description ? `${mention} (${description})` : mention;
    }
    case "url":
      return withUrl(link.label ?? "", link.url).trim();
  }
}

/**
 * The first message of a chat started from a task: its title, its notes, then
 * what it links to, one bullet per link. Chats are written as `@thread:<id>`
 * mentions so they travel as thread references.
 */
export function buildTaskStartPrompt(input: TaskStartPromptInput): string {
  const sections = [input.title.trim()];
  const notes = input.notes.trim();
  if (notes) sections.push(notes);
  if (input.links.length > 0)
    sections.push(
      [
        "Linked:",
        ...input.links.map((link) => `- ${describeTaskLink(link, input.describeThread)}`),
      ].join("\n"),
    );
  return sections.join("\n\n");
}
