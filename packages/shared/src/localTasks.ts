import type { LocalTaskDelegationStatus } from "@ryco/contracts";

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
