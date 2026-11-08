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
  applicableUsageLimit,
  buildThreadInbox,
  deriveThreadActivityStatus,
  isDelegatedThreadLineage,
  isThreadFailed,
  type SidebarThreadSummary,
  type SidebarWorktreeSummary,
  summarizeAgentActivity,
  type ThreadAttentionRowState,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { PUSH_ATTENTION_MAX_DELIVERIES, type PushActivityCounts } from "@ryco/contracts/push-hub";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";

import type { PushRegistration } from "./pushRegistrations.ts";

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

const epochMs = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** A row's state on a node that is its own, always-current machine (the phone's row state). */
function rowState(thread: SidebarThreadSummary): ThreadAttentionRowState {
  const activity = deriveThreadActivityStatus(thread);
  if (activity === "approval" || activity === "input" || activity === "plan-ready") {
    return "needs-input";
  }
  if (activity === "working") return "working";
  if (activity === "connecting") return "connecting";
  if (applicableUsageLimit(thread) !== null) return "limited";
  if (isThreadFailed(thread)) return "error";
  return "idle";
}

function attentionOf(thread: SidebarThreadSummary): AgentActivityThread["attention"] {
  const status = deriveThreadActivityStatus(thread);
  return status === "approval"
    ? "approval"
    : status === "input"
      ? "input"
      : status === "plan-ready"
        ? "plan"
        : null;
}

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
  const inbox = buildThreadInbox({
    projects: [],
    // One machine: every row is this node's, whatever id it was read with.
    worktrees: input.worktrees.map((worktree) =>
      worktree.environmentId === input.environmentId
        ? worktree
        : { ...worktree, environmentId: input.environmentId },
    ),
    threads: Array.from(input.threads, (thread) =>
      thread.environmentId === input.environmentId
        ? thread
        : { ...thread, environmentId: input.environmentId },
    ),
    environments: [
      {
        environmentId: input.environmentId,
        label: "",
        threadSettlementSupported: true,
        threadSnoozeSupported: true,
        threadTriageSupported: true,
        autoSettleAfterDays: input.autoSettleAfterDays,
        connected: true,
        mutationReady: true,
        shellCurrent: true,
      },
    ],
    nowMs: input.nowMs,
  });
  let nextChangeAtMs = inbox.nextSettlementEvaluationAtMs;
  const later = (atMs: number) => {
    if (atMs > input.nowMs && (nextChangeAtMs === null || atMs < nextChangeAtMs)) {
      nextChangeAtMs = atMs;
    }
  };
  // Only Active rows can count: settled, snoozed and hidden ones rest.
  const threads = inbox.active.flatMap((entry): AgentActivityThread[] => {
    const thread = entry.thread;
    if (thread === null) return [];
    const finishedAtMs =
      thread.latestTurn?.state === "running" ? null : epochMs(thread.latestTurn?.completedAt);
    if (finishedAtMs !== null) later(finishedAtMs + AGENT_ACTIVITY_RECENT_RESULT_MS + 1);
    return [
      {
        key: entry.key,
        environmentId: thread.environmentId,
        threadId: thread.id,
        title: "",
        projectName: null,
        live: true,
        state: rowState(thread),
        attention: attentionOf(thread),
        resting: false,
        // As on the phone: no record of which results were seen, so one counts for its window.
        unseen: true,
        delegated: isDelegatedThreadLineage(thread.lineage),
        finishedAtMs,
        updatedAtMs: epochMs(thread.updatedAt) ?? 0,
      },
    ];
  });
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
 * The devices one activity pass signals: every Live Activity registration not in front whose
 * counts changed, that must hear them again, or whose held counts are due for a refresh. A
 * device that never heard anything above zero hears nothing about zero.
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
    if (registration.liveActivity !== true) continue;
    if (input.isForeground(registration.enrollmentId)) continue;
    const previous = input.sent.get(registration.enrollmentId);
    const due =
      previous === undefined
        ? !activityCountsZero(input.counts)
        : previous.resend ||
          !activityCountsEqual(previous.counts, input.counts) ||
          (previous.held &&
            !activityCountsZero(input.counts) &&
            input.nowMs - previous.atMs >= ACTIVITY_REFRESH_MS);
    if (due) recipients.push(registration.enrollmentId);
  }
  const chunks: string[][] = [];
  for (let index = 0; index < recipients.length; index += PUSH_ATTENTION_MAX_DELIVERIES) {
    chunks.push(recipients.slice(index, index + PUSH_ATTENTION_MAX_DELIVERIES));
  }
  return chunks;
}
