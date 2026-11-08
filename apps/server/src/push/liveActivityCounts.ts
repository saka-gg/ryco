/**
 * liveActivityCounts - What this node tells its Hub about each device's agent Live Activity
 * (`docs/live-activity-push.md`): four counts, and when they need sending.
 *
 * The counts follow the card's own rule (`summarizeAgentActivity`) over the node's threads as
 * its Inbox lists them (`buildThreadInbox` with the node's own settlement rule): live threads
 * only, a result counts for 15 minutes, snoozed, settled and hidden threads never. Nothing but
 * the four numbers ever leaves this module: no title, thread id, project or model.
 *
 * @module push/liveActivityCounts
 */
import {
  AGENT_ACTIVITY_RECENT_RESULT_MS,
  type AgentActivityThread,
  agentActivityThreadFields,
  createThreadWorktreeResolver,
  liveThreadRowState,
  placeThreadInInbox,
  type SidebarThreadSummary,
  type SidebarWorktreeSummary,
  summarizeAgentActivity,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import type { PushActivityCounts } from "@ryco/contracts/push-hub";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";

import type { PushRegistration } from "./pushRegistrations.ts";
import { chunkForSignals } from "./pushSignalChunks.ts";

/** Activity signals closer together than this become one: the latest counts win. */
export const ACTIVITY_MIN_INTERVAL_MS = 5_000;
/**
 * Counts that did not change are sent again this often while any is above zero: the Hub drops a
 * node from its sum after 10 minutes without word, and moves the card's stale date on a refresh.
 */
export const ACTIVITY_REFRESH_MS = 4 * 60_000;
/** While a Live Activity device is in front, its presence is looked at again this often. */
export const ACTIVITY_FOREGROUND_RECHECK_MS = 15_000;

export const ZERO_ACTIVITY_COUNTS: PushActivityCounts = Object.freeze({
  running: 0,
  needsYou: 0,
  failed: 0,
  done: 0,
});

export const activityCountsEqual = (left: PushActivityCounts, right: PushActivityCounts) =>
  left.running === right.running &&
  left.needsYou === right.needsYou &&
  left.failed === right.failed &&
  left.done === right.done;

export const activityCountsZero = (counts: PushActivityCounts) =>
  activityCountsEqual(counts, ZERO_ACTIVITY_COUNTS);

export interface NodeAgentActivity {
  readonly counts: PushActivityCounts;
  /** When the counts may change without any thread changing (a result ages out, a snooze wakes). */
  readonly nextChangeAtMs: number | null;
}

/** This node's counts now, over its own thread rows. */
export function countNodeAgentActivity(input: {
  readonly environmentId: EnvironmentId;
  readonly threads: Iterable<SidebarThreadSummary>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  /** The node's own automatic settlement rule; undefined falls back to the default. */
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays | undefined;
  readonly nowMs: number;
}): NodeAgentActivity {
  // One machine: every row is this node's, whatever id it was read with.
  const own = <T extends { readonly environmentId: EnvironmentId }>(row: T): T =>
    row.environmentId === input.environmentId
      ? row
      : { ...row, environmentId: input.environmentId };
  const worktreeOf = createThreadWorktreeResolver(input.worktrees.map(own));
  const environment = {
    threadSettlementSupported: true,
    autoSettleAfterDays: input.autoSettleAfterDays,
  } as const;
  const clientAutoSettleAfterDays = resolveAutoSettleAfterDays(undefined);
  let nextChangeAtMs: number | null = null;
  const later = (atMs: number) => {
    if (atMs > input.nowMs && (nextChangeAtMs === null || atMs < nextChangeAtMs)) {
      nextChangeAtMs = atMs;
    }
  };
  const threads: AgentActivityThread[] = [];
  for (const row of input.threads) {
    const thread = own(row);
    // The Inbox's own placement rule, without building the whole Inbox. Automatic settlement
    // (days without activity) never reaches a thread that counts: those run, wait, or ended
    // within the last 15 minutes.
    const placement = placeThreadInInbox({
      thread,
      worktree: worktreeOf(thread),
      environment,
      pinned: false,
      // The node's own follow-up queue counts as the phone's Inbox counts it.
      hasLocalQueuedMessage: thread.followUpQueueSummary !== undefined,
      deliveryUnknown: false,
      clientAutoSettleAfterDays,
      nowMs: input.nowMs,
    });
    if (placement.snoozed) later(Date.parse(thread.snoozedUntil ?? ""));
    // Only Active rows can count: settled, snoozed, hidden and archived ones rest.
    if (placement.classification !== "active") continue;
    const fields = agentActivityThreadFields(thread);
    if (fields.finishedAtMs !== null) {
      later(fields.finishedAtMs + AGENT_ACTIVITY_RECENT_RESULT_MS + 1);
    }
    threads.push({
      ...fields,
      key: `${thread.environmentId}:${thread.id}`,
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: "",
      projectName: null,
      live: true,
      state: liveThreadRowState(thread),
      resting: false,
      // As on the phone: no record of which results were seen, so one counts for its window.
      unseen: true,
    });
  }
  const { counts } = summarizeAgentActivity(threads, input.nowMs);
  return { counts, nextChangeAtMs };
}

/** What the Hub holds of this node's counts for one device, as far as the node knows. */
export interface SentActivity {
  readonly counts: PushActivityCounts;
  readonly atMs: number;
  /** The Hub keeps them (it answered `accepted`); `no-token` keeps nothing to refresh. */
  readonly held: boolean;
  /** Send again whatever the counts: the device was in front, or the Hub asked to wait. */
  readonly resend: boolean;
}

/**
 * The devices one activity pass signals, among the Live Activity registrations it is given:
 * every one not in front whose counts changed, that must hear them again, or whose held counts
 * are due for a refresh. A device this node has told nothing since it started hears its counts
 * once, zero included: after a restart the Hub may still hold counts the node sent before it.
 */
export function planActivityRecipients(input: {
  readonly registrations: ReadonlyArray<PushRegistration>;
  readonly isForeground: (enrollmentId: string) => boolean;
  readonly sent: ReadonlyMap<string, SentActivity>;
  readonly counts: PushActivityCounts;
  readonly nowMs: number;
}): ReadonlyArray<ReadonlyArray<string>> {
  const recipients: string[] = [];
  for (const registration of input.registrations) {
    if (input.isForeground(registration.enrollmentId)) continue;
    const previous = input.sent.get(registration.enrollmentId);
    const due =
      previous === undefined ||
      previous.resend ||
      !activityCountsEqual(previous.counts, input.counts) ||
      (previous.held &&
        !activityCountsZero(input.counts) &&
        // Passes run on their own timers: a pass a little early still refreshes.
        input.nowMs - previous.atMs >= ACTIVITY_REFRESH_MS - ACTIVITY_MIN_INTERVAL_MS);
    if (due) recipients.push(registration.enrollmentId);
  }
  return chunkForSignals(recipients);
}
