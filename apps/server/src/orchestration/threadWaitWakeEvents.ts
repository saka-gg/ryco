/**
 * Which orchestration events can end a wait on a thread.
 *
 * Agent Control waits (`ryco_wait_threads`, the executor's idle and interrupt
 * settlement) re-read a thread's shell when one of these events arrives, and
 * otherwise only on a slow fallback re-check. The classification is projection
 * knowledge: it names the events whose projection can move a waited-on
 * predicate (session status, latest turn, pending requests, background
 * liveness, archive and delete state) toward "done".
 *
 * Over-including a rare event costs one extra read. Over-including a frequent
 * one (streaming text, tool activity, per-tick subagent updates, one completed
 * assistant message per agent step) would read more than the poll this
 * replaced, so those are excluded. A missed event costs latency up to the
 * fallback re-check, never a wrong result: waits decide from fresh reads.
 *
 * Pure module: no services, no I/O.
 *
 * @module threadWaitWakeEvents
 */
import type {
  OrchestrationEvent,
  OrchestrationEventType,
  OrchestrationThreadActivity,
} from "@ryco/contracts";
import { BACKGROUND_WORK_BOUNDARY } from "@ryco/shared/backgroundWork";
import { endsTaskLiveness } from "@ryco/shared/taskClassification";
import { PENDING_REQUEST_ACTIVITY_KINDS } from "@ryco/shared/threadActivity";

import { inheritedTurnOutcomes } from "./forkInheritance.ts";
import { turnStartEndedMessageId } from "./providerEffectIntents.ts";

type ThreadWaitRoute = "wake" | "ignore" | "activity";

// Exhaustive: a new event type does not compile until someone classifies it.
const THREAD_WAIT_ROUTES = {
  "project.created": "ignore",
  "project.meta-updated": "ignore",
  "project.avatar-set": "ignore",
  "project.deleted": "ignore",
  "thread.created": "ignore",
  // A missing thread ends a wait.
  "thread.deleted": "wake",
  // Trash does not hide a thread from shell reads.
  "thread.trashed": "ignore",
  "thread.untrashed": "ignore",
  // The executor's queue wait fails on an archived target.
  "thread.archived": "wake",
  "thread.unarchived": "ignore",
  "thread.snoozed": "ignore",
  "thread.unsnoozed": "ignore",
  // Inbox settle state, not the session.
  "thread.settled": "ignore",
  "thread.unsettled": "ignore",
  "thread.usage-limit-set": "ignore",
  "thread.usage-limit-cleared": "ignore",
  "thread.meta-updated": "ignore",
  "thread.runtime-mode-set": "ignore",
  "thread.interaction-mode-set": "ignore",
  "thread.token-mode-set": "ignore",
  "thread.goal-updated": "ignore",
  "thread.goal-cleared": "ignore",
  "thread.context-handoff-requested": "ignore",
  // Streaming text arrives every few milliseconds, and every completed assistant message (one
  // per agent step) marks the latest turn completed while the session still runs. The turn's
  // end arrives atomically with the session-set that releases it (`resolveReleasedTurn`).
  "thread.message-sent": "ignore",
  // A steer, start or stop request is followed by a session-set when it changes anything.
  "thread.turn-steer-requested": "ignore",
  "thread.turn-steer-accepted": "ignore",
  "thread.turn-steer-rejected": "ignore",
  "thread.turn-start-requested": "ignore",
  "thread.turn-interrupt-requested": "wake",
  // They do not change pending counts today, but they are rare and sit next to pending state.
  "thread.approval-response-requested": "wake",
  "thread.user-input-response-requested": "wake",
  "thread.checkpoint-revert-requested": "ignore",
  "thread.reverted": "wake",
  "thread.session-stop-requested": "ignore",
  "thread.session-set": "wake",
  "thread.proposed-plan-upserted": "ignore",
  "thread.turn-diff-completed": "wake",
  "thread.activity-appended": "activity",
  "worktree.created": "ignore",
  "worktree.archived": "ignore",
  "worktree.metaUpdated": "ignore",
  "worktree.sourceControlStateUpdated": "ignore",
  "worktree.restored": "ignore",
  "worktree.deleted": "ignore",
  "worktree.checkoutRemoved": "ignore",
  "worktree.checkoutRestored": "ignore",
  "worktree.relocated": "ignore",
  "thread.attachedToWorktree": "ignore",
  "thread.statusBucketOverridden": "ignore",
  "thread.manualPositionSet": "ignore",
  "worktree.manualPositionSet": "ignore",
} as const satisfies Record<OrchestrationEventType, ThreadWaitRoute>;

/**
 * Activity kinds that change a thread's pending approval or user-input counts (the kinds
 * `derivePendingThreadRequests` reads). A new request makes `ryco_wait_threads` return.
 */
const PENDING_REQUEST_ACTIVITY_KIND_SET: ReadonlySet<string> = new Set(
  PENDING_REQUEST_ACTIVITY_KINDS,
);

/** Task and subagent ends: background liveness always drops the task. */
const TASK_END_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "task.completed",
  "subagent.completed",
]);

/**
 * Task and subagent updates. Providers send these on every progress tick (Claude's
 * `subagent.updated` per task tick, OpenCode's per child tool part, Codex's per collab-agent
 * activity), almost always with a running status that cannot end a wait. Only an update whose
 * status ends liveness (`endsTaskLiveness`, the status rule the liveness registry applies) wakes.
 * The registry also drops a task that a running update reclassifies (an inert task type, an
 * agent-owned shell, a newer runtime): those rare drops are left to the fallback re-check,
 * because waking on every agent-owned update would bring the per-tick reads back.
 */
const TASK_UPDATE_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "task.updated",
  "task.progress",
  "subagent.updated",
]);

const activityStatus = (activity: OrchestrationThreadActivity): string | undefined => {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || !("status" in payload)) return undefined;
  return typeof payload.status === "string" ? payload.status : undefined;
};

/** Whether an appended activity can end a wait on `threadId`. */
export const isThreadWaitWakeActivity = (
  threadId: string,
  activity: OrchestrationThreadActivity,
): boolean => {
  const kind = activity.kind;
  if (PENDING_REQUEST_ACTIVITY_KIND_SET.has(kind) || TASK_END_ACTIVITY_KINDS.has(kind)) return true;
  if (TASK_UPDATE_ACTIVITY_KINDS.has(kind)) return endsTaskLiveness(activityStatus(activity));
  // A session start or stop: ingestion clears the thread's liveness after the stopping
  // session-set, and this activity is appended after the clear.
  if (kind === BACKGROUND_WORK_BOUNDARY) return true;
  // A failed or cancelled turn start removes the pending turn row.
  if (turnStartEndedMessageId(activity) !== null) return true;
  // Fork provenance rewrites inherited turn states.
  return inheritedTurnOutcomes(threadId, activity).length > 0;
};

/** Whether `event` can end a `ryco_wait_threads` wait on its thread. */
export const isThreadWaitWakeEvent = (event: OrchestrationEvent): boolean => {
  switch (THREAD_WAIT_ROUTES[event.type]) {
    case "wake":
      return true;
    case "ignore":
      return false;
    case "activity":
      return (
        event.type === "thread.activity-appended" &&
        isThreadWaitWakeActivity(event.payload.threadId, event.payload.activity)
      );
    default:
      // An event type this server build does not know (newer peer): the fallback re-check covers it.
      return false;
  }
};

/**
 * Whether `event` can change a thread's session or archive state or delete it: the only inputs
 * of the executor's idle and interrupt settlement waits.
 */
export const isThreadSessionWakeEvent = (event: OrchestrationEvent): boolean =>
  event.type === "thread.session-set" ||
  event.type === "thread.archived" ||
  event.type === "thread.deleted";
