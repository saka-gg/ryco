import type {
  CommandId,
  LocalTask,
  LocalTaskDelegation,
  LocalTaskDelegationStatus,
  LocalTaskLink,
  ThreadId,
} from "@ryco/contracts";
import { resolveUniqueRefName, sanitizeBranchFragment } from "@ryco/shared/git";
import { aggregateLocalTaskStatus, type LocalTaskChatAggregate } from "@ryco/shared/localTasks";

import { deriveThreadActivityStatus } from "../threads/threadActivityStatus.ts";
import { isThreadFailed } from "../threads/threadFailure.ts";
import type {
  LocalTaskOptimisticStart,
  LocalTaskThreadSummary,
  LocalTaskThreadSummaryReader,
  LocalTaskView,
} from "./types.ts";

/**
 * Pure task rules shared by every client: how a chat's live state reads on a
 * task, its branch name, and the order tasks are listed in. The first message
 * a task's chat starts with is `@ryco/shared/localTasks`' (the node writes it
 * too, for chats agents start).
 */
export { buildTaskStartPrompt, type TaskStartPromptInput } from "@ryco/shared/localTasks";

/** The start a chat came from, as far as its status needs it. */
export type TaskChatStart = Pick<LocalTaskDelegation, "messageId" | "createdAt">;

/**
 * How one chat reads on its task from the live thread, falling back to the
 * node's word (`serverStatus`) when this client has no summary for it:
 * - a pending approval, a question or a plan to review: `needs-you`;
 * - a running turn or live background work (`working`, `monitoring`): `running`;
 * - a session still connecting: `starting`;
 * - settled: `failed` when the start failed or the turn or session ended in an
 *   error, `starting` before the first turn is projected, otherwise `review`.
 *
 * The node's `failed` (the start never got going) holds only until the chat
 * runs a turn of its own after `start`: the user took the chat over then, and
 * it reads like any chat.
 */
export function resolveTaskChatStatus(
  serverStatus: LocalTaskDelegationStatus,
  summary: LocalTaskThreadSummary | null | undefined,
  start?: TaskChatStart,
): LocalTaskDelegationStatus {
  if (!summary) return serverStatus;
  const startFailed = serverStatus === "failed" && !ranTurnAfterStart(summary, start);
  return liveChatStatus(summary, startFailed, "starting");
}

/** The chat's latest turn is not the start's and was asked for after it. */
function ranTurnAfterStart(
  summary: LocalTaskThreadSummary,
  start: TaskChatStart | undefined,
): boolean {
  const turn = summary.latestTurn;
  return (
    start !== undefined &&
    turn !== null &&
    turn.userMessageId !== start.messageId &&
    turn.requestedAt > start.createdAt
  );
}

/**
 * A chat linked to the task by hand: the node knows nothing about it, so a
 * thread this client can't see reads as `unavailable`, and one with no turn
 * yet has nothing in flight (`review`).
 */
export function resolveLinkedChatStatus(
  summary: LocalTaskThreadSummary | null | undefined,
): LocalTaskDelegationStatus {
  return summary ? liveChatStatus(summary, false, "review") : "unavailable";
}

function liveChatStatus(
  summary: LocalTaskThreadSummary,
  startFailed: boolean,
  beforeFirstTurn: "starting" | "review",
): LocalTaskDelegationStatus {
  switch (deriveThreadActivityStatus(summary)) {
    case "approval":
    case "input":
    case "plan-ready":
      return "needs-you";
    case "working":
    case "monitoring":
      return "running";
    case "connecting":
      return "starting";
    case "idle":
      if (startFailed || isThreadFailed(summary)) return "failed";
      return summary.latestTurn === null ? beforeFirstTurn : "review";
  }
}

/** One chat of a task, as its chat list shows it. */
export interface LocalTaskChat {
  /** Stable key: the start's command id, or `thread:<id>` for a linked chat. */
  readonly key: string;
  readonly threadId: ThreadId;
  readonly status: LocalTaskDelegationStatus;
  /** The start's worktree branch, else the thread's own; `null` when unknown. */
  readonly branch: string | null;
  /** Linked by hand rather than started from the task. */
  readonly linked: boolean;
  /** Sent from here; the node has not confirmed the start yet. */
  readonly optimistic: boolean;
  /** Why the start failed before its chat could run. */
  readonly error: string | null;
  /**
   * The node recorded the start as failed and the chat never ran a turn of its
   * own: the start itself is what failed. A chat that ran and then stopped on
   * an error is `failed` without this.
   */
  readonly startFailed: boolean;
}

type TaskChatSource = Pick<LocalTaskView, "delegations" | "links"> & {
  readonly optimisticStarts?: ReadonlyArray<LocalTaskOptimisticStart>;
};

/**
 * A task's chats: its starts oldest first, starts not confirmed yet, then the
 * chats linked by hand that it did not start itself.
 */
export function listTaskChats(
  task: TaskChatSource,
  getSummary: LocalTaskThreadSummaryReader,
): LocalTaskChat[] {
  const chats: LocalTaskChat[] = [];
  const started = new Set<string>();
  const commands = new Set<string>();
  for (const delegation of task.delegations) {
    const summary = getSummary(delegation.threadId);
    started.add(delegation.threadId);
    commands.add(delegation.commandId);
    chats.push({
      key: delegation.commandId,
      threadId: delegation.threadId,
      status: resolveTaskChatStatus(delegation.status, summary, delegation),
      branch: delegation.branch ?? summary?.branch ?? null,
      linked: false,
      optimistic: false,
      error: delegation.error,
      startFailed:
        delegation.status === "failed" && !(summary && ranTurnAfterStart(summary, delegation)),
    });
  }
  for (const start of task.optimisticStarts ?? []) {
    if (commands.has(start.commandId)) continue;
    const summary = getSummary(start.threadId);
    started.add(start.threadId);
    chats.push({
      key: start.commandId,
      threadId: start.threadId,
      status: resolveTaskChatStatus(start.status, summary),
      branch: start.branch ?? summary?.branch ?? null,
      linked: false,
      optimistic: true,
      error: null,
      startFailed: false,
    });
  }
  for (const link of task.links) {
    if (link.kind !== "thread" || started.has(link.threadId)) continue;
    started.add(link.threadId);
    const summary = getSummary(link.threadId);
    chats.push({
      key: `thread:${link.threadId}`,
      threadId: link.threadId,
      status: resolveLinkedChatStatus(summary),
      branch: summary?.branch ?? null,
      linked: true,
      optimistic: false,
      error: null,
      startFailed: false,
    });
  }
  return chats;
}

/**
 * The most urgent status among a task's chats (`aggregateLocalTaskStatus`,
 * the node's own rule), or `null` when it has no chat that is still there.
 */
export function taskLiveStatus(
  task: TaskChatSource,
  getSummary: LocalTaskThreadSummaryReader,
): Exclude<LocalTaskChatAggregate, "todo"> | null {
  const status = aggregateLocalTaskStatus(
    listTaskChats(task, getSummary).map((chat) => chat.status),
  );
  return status === "todo" ? null : status;
}

/**
 * Whether the start the node recorded for `commandId` failed before its chat
 * could run: its dispatch failed, orchestration refused it, or a restart cut it
 * off. Resending the command runs it again unless orchestration refused it.
 */
export function taskStartFailed(
  task: Pick<LocalTask, "delegations">,
  commandId: CommandId,
): boolean {
  const start = task.delegations.find((delegation) => delegation.commandId === commandId);
  return start !== undefined && !start.dispatched && start.status === "failed";
}

/**
 * Whether a task's project is fixed: one of its starts may have a chat in it.
 * That is a start sent from here and not confirmed yet, one whose chat this
 * client knows (`threadExists`), or one the node does not read as failed or
 * gone. A start that failed before its chat existed, or whose chat was
 * deleted, holds nothing. The node applies the same rule to a project change.
 */
export function taskProjectLocked(
  task: TaskChatSource,
  threadExists: (threadId: ThreadId) => boolean,
): boolean {
  return (
    (task.optimisticStarts?.length ?? 0) > 0 ||
    task.delegations.some(
      (start) =>
        threadExists(start.threadId) ||
        (start.status !== "failed" && start.status !== "unavailable"),
    )
  );
}

/** One key per thing a link points at; two links with the same key are the same link. */
export function taskLinkKey(link: LocalTaskLink): string {
  switch (link.kind) {
    case "pr":
      return `pr:${link.number}`;
    case "issue":
      return `issue:${link.number}`;
    case "workItem":
      return `workItem:${link.provider}:${link.key}`;
    case "branch":
      return `branch:${link.name}`;
    case "thread":
      return `thread:${link.threadId}`;
    case "url":
      return `url:${link.url}`;
  }
}

export function hasTaskLink(links: ReadonlyArray<LocalTaskLink>, link: LocalTaskLink): boolean {
  const key = taskLinkKey(link);
  return links.some((existing) => taskLinkKey(existing) === key);
}

/** Open tasks with a chat waiting on the user: the sidebar entry's badge. */
export function countTasksNeedingUser(
  tasks: Iterable<TaskChatSource & Pick<LocalTask, "state">>,
  getSummary: LocalTaskThreadSummaryReader,
): number {
  let count = 0;
  for (const task of tasks)
    if (task.state !== "done" && taskLiveStatus(task, getSummary) === "needs-you") count += 1;
  return count;
}

/**
 * A cheap fingerprint of the live state of every open task's chats
 * (`threadId:activity:latestTurnState`). It changes exactly when one of them
 * moves between states, which is when the node's status for the task may have
 * changed too and is worth re-reading.
 */
export function delegatedThreadSignature(
  tasks: Iterable<TaskChatSource & Pick<LocalTask, "state">>,
  getSummary: LocalTaskThreadSummaryReader,
): string {
  let signature = "";
  const add = (threadId: ThreadId) => {
    const summary = getSummary(threadId);
    signature += `${threadId}:${summary ? deriveThreadActivityStatus(summary) : "-"}:${
      summary?.latestTurn?.state ?? "-"
    },`;
  };
  for (const task of tasks) {
    if (task.state === "done") continue;
    for (const delegation of task.delegations) add(delegation.threadId);
    for (const start of task.optimisticStarts ?? []) add(start.threadId);
    for (const link of task.links) if (link.kind === "thread") add(link.threadId);
  }
  return signature;
}

/** Words a branch name skips: they make it longer without telling tasks apart. */
const TASK_BRANCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "on",
  "in",
  "to",
  "for",
  "of",
  "idea",
  "when",
  "is",
]);
const TASK_BRANCH_SLUG_WORDS = 4;
const TASK_BRANCH_FALLBACK_SLUG = "task";

/** The branch slug of a task's title: its first four meaningful words, e.g. `fix-login-redirect-loop`. */
export function taskBranchSlug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((word) => word && !TASK_BRANCH_STOP_WORDS.has(word))
    .slice(0, TASK_BRANCH_SLUG_WORDS);
  return words.length > 0 ? sanitizeBranchFragment(words.join("-")) : TASK_BRANCH_FALLBACK_SLUG;
}

/**
 * The branch of a task's next worktree: `task/<slug>` for its first chat,
 * `task/<slug>-<n>` for its n-th, each moved on to the next free number when a
 * ref already has that name. Pass the task's earlier start branches with the
 * refs so a branch not listed yet is never handed out twice.
 */
export function nextTaskBranchName(input: {
  readonly slug: string;
  readonly delegationCount: number;
  readonly existingRefNames: readonly string[];
}): string {
  const base = `task/${input.slug}`;
  if (input.delegationCount === 0) return resolveUniqueRefName(base, input.existingRefNames);
  // Listing the base as taken numbers on from the task's own count.
  return resolveUniqueRefName(base, [...input.existingRefNames, base], input.delegationCount + 1);
}

type SortableTask = Pick<LocalTask, "taskId" | "createdAt" | "updatedAt">;

function compareDescending(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0;
}

/** Open tasks: newest first. */
export function compareOpenTasks(left: SortableTask, right: SortableTask): number {
  return (
    compareDescending(left.createdAt, right.createdAt) ||
    compareDescending(left.taskId, right.taskId)
  );
}

/** Completed tasks: most recently changed (checked off) first. */
export function compareDoneTasks(left: SortableTask, right: SortableTask): number {
  return (
    compareDescending(left.updatedAt, right.updatedAt) ||
    compareDescending(left.taskId, right.taskId)
  );
}

export function sortOpenTasks<T extends SortableTask>(tasks: ReadonlyArray<T>): T[] {
  return tasks.toSorted(compareOpenTasks);
}

export function sortDoneTasks<T extends SortableTask>(tasks: ReadonlyArray<T>): T[] {
  return tasks.toSorted(compareDoneTasks);
}
