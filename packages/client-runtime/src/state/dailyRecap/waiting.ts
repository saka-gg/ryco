// @effect-diagnostics globalDate:off
import type { EnvironmentId } from "@ryco/contracts";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";

import type { AppState, EnvironmentState } from "../threads/store.ts";
import { deriveThreadActivityStatus } from "../threads/threadActivityStatus.ts";
import { isUnarchivedThreadEntry } from "../threads/types.ts";

type ThreadSummaries = EnvironmentState["sidebarThreadSummaryById"];

interface WaitingCount {
  readonly count: number;
  /** When a snooze that hides a waiting chat runs out: the count is good until then. */
  readonly validUntilMs: number;
}

function countWaiting(summaries: ThreadSummaries, nowMs: number): WaitingCount {
  let count = 0;
  let validUntilMs = Number.POSITIVE_INFINITY;
  for (const entry of Object.values(summaries)) {
    if (!isUnarchivedThreadEntry(entry)) continue;
    const activity = deriveThreadActivityStatus(entry);
    if (activity !== "approval" && activity !== "input" && activity !== "plan-ready") continue;
    if (isThreadSnoozed(entry, nowMs)) {
      validUntilMs = Math.min(validUntilMs, Date.parse(entry.snoozedUntil ?? ""));
      continue;
    }
    count += 1;
  }
  return { count, validUntilMs };
}

/**
 * A store selector of how many chats on `environmentIds` wait on the user
 * right now: an approval, an answer or a plan to review, the chats the inbox
 * lists as needing input. Archived and snoozed chats do not count. A node's
 * threads are rescanned only when its summaries changed or a snooze ran out.
 */
export function createWaitingThreadCountSelector(): (
  state: AppState,
  environmentIds: readonly EnvironmentId[],
  nowMs: number,
) => number {
  const countBySummaries = new WeakMap<ThreadSummaries, WaitingCount>();
  return (state, environmentIds, nowMs) => {
    let total = 0;
    for (const environmentId of environmentIds) {
      const summaries = state.environmentStateById[environmentId]?.sidebarThreadSummaryById;
      if (summaries === undefined) continue;
      let waiting = countBySummaries.get(summaries);
      if (waiting === undefined || nowMs >= waiting.validUntilMs) {
        waiting = countWaiting(summaries, nowMs);
        countBySummaries.set(summaries, waiting);
      }
      total += waiting.count;
    }
    return total;
  };
}
