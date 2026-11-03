import type { EnvironmentId } from "@ryco/contracts";

import type { AppState, EnvironmentState } from "../threads/store.ts";
import { selectEnvironmentShellLive } from "../threads/storeSelectors.ts";
import { deriveThreadActivityStatus } from "../threads/threadActivityStatus.ts";
import { isUnarchivedThreadEntry } from "../threads/types.ts";

type ThreadSummaries = EnvironmentState["sidebarThreadSummaryById"];

function countWaiting(summaries: ThreadSummaries): number {
  let count = 0;
  for (const entry of Object.values(summaries)) {
    if (!isUnarchivedThreadEntry(entry)) continue;
    const activity = deriveThreadActivityStatus(entry);
    if (activity === "approval" || activity === "input") count += 1;
  }
  return count;
}

/**
 * A store selector of how many chats on `environmentIds` wait on the user
 * right now for an approval or an answer: chats the inbox lists as needing
 * input, since no snooze hides them. Plans to review are left out, because a
 * snooze can hide those and the snooze rules would add a chunk to the web
 * shell's graph. Archived chats do not count, and neither do the last-known
 * chats of a node whose shell is not live (the inbox shows those as offline).
 * A node's threads are rescanned only when its summaries changed.
 */
export function createWaitingThreadCountSelector(): (
  state: AppState,
  environmentIds: readonly EnvironmentId[],
) => number {
  const countBySummaries = new WeakMap<ThreadSummaries, number>();
  return (state, environmentIds) => {
    let total = 0;
    for (const environmentId of environmentIds) {
      if (!selectEnvironmentShellLive(state, environmentId)) continue;
      const summaries = state.environmentStateById[environmentId]?.sidebarThreadSummaryById;
      if (summaries === undefined) continue;
      let waiting = countBySummaries.get(summaries);
      if (waiting === undefined) {
        waiting = countWaiting(summaries);
        countBySummaries.set(summaries, waiting);
      }
      total += waiting;
    }
    return total;
  };
}
