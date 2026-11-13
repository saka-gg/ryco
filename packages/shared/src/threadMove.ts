/**
 * "Move to project": the rules server and clients share (see `@ryco/contracts/thread-move`).
 *
 * - Which threads can move now (`threadProjectMoveBlocker`), worded once for menus and the decider.
 * - Where a moved thread's checkpoints stop being usable (`threadMoveCheckpointFloor`): every
 *   checkpoint up to the newest move's count was captured in another checkout.
 *
 * @module threadMove
 */
import type { OrchestrationThreadActivity } from "@ryco/contracts/orchestration";
import {
  THREAD_MOVED_ACTIVITY_KIND,
  ThreadMovedActivityPayload,
} from "@ryco/contracts/thread-move";
import * as Schema from "effect/Schema";

const decodeMovedPayload = Schema.decodeUnknownOption(ThreadMovedActivityPayload);

export function isThreadMovedActivity(
  activity: Pick<OrchestrationThreadActivity, "kind">,
): boolean {
  return activity.kind === THREAD_MOVED_ACTIVITY_KIND;
}

/** The newest move's record, or null for a thread that never moved (or an unreadable record). */
export function latestThreadMove(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): ThreadMovedActivityPayload | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (!isThreadMovedActivity(activity)) continue;
    const decoded = decodeMovedPayload(activity.payload);
    if (decoded._tag === "Some") return decoded.value;
  }
  return null;
}

/**
 * The newest move's checkpoint turn count, or null when the thread never moved. Checkpoints up to
 * it belong to the old checkout: no restore to an earlier one, and no diff that starts below it.
 */
export function threadMoveCheckpointFloor(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): number | null {
  return latestThreadMove(activities)?.checkpointTurnCount ?? null;
}

/**
 * Whether checkpoint `turnCount` was captured before the thread moved: it is shown, but never
 * restored or diffed (its snapshot lives in the old checkout's repository). The floor itself is
 * usable as a revert target once a turn ran after the move: that turn captured its baseline in
 * the new checkout under the same count.
 */
export function isCheckpointBeforeThreadMove(turnCount: number, floor: number | null): boolean {
  return floor !== null && turnCount < floor;
}

/** Whether a turn's own diff (`turnCount - 1` to `turnCount`) reaches back before the move. */
export function isTurnDiffBeforeThreadMove(turnCount: number, floor: number | null): boolean {
  return floor !== null && turnCount <= floor;
}

/** Why checkpoints from before a move are not offered. */
export const CHECKPOINT_BEFORE_MOVE_MESSAGE =
  "This is from before the thread moved to another project. Its files are in the old checkout.";

export type ThreadProjectMoveBlocker =
  | "thread-archived"
  | "thread-deleted"
  | "session-starting"
  | "session-running"
  | "background-work"
  | "pending-approval"
  | "pending-user-input"
  | "queued-turn"
  | "context-handoff"
  | "checkpoint-revert";

export interface ThreadProjectMoveInput {
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly sessionStatus: string | null;
  readonly latestTurnRunning: boolean;
  /** Native background work (subagents) still alive after the turn. */
  readonly backgroundWorking: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /** A message was sent and its turn has not started yet. */
  readonly queuedTurn: boolean;
  readonly contextHandoffPending: boolean;
  readonly checkpointRevertPending: boolean;
}

/** The first reason a thread cannot move now, or null. Same order on server and clients. */
export function threadProjectMoveBlocker(
  input: ThreadProjectMoveInput,
): ThreadProjectMoveBlocker | null {
  if (input.deleted) return "thread-deleted";
  if (input.archived) return "thread-archived";
  if (input.sessionStatus === "starting") return "session-starting";
  if (input.sessionStatus === "running" || input.latestTurnRunning) return "session-running";
  if (input.hasPendingApprovals) return "pending-approval";
  if (input.hasPendingUserInput) return "pending-user-input";
  if (input.queuedTurn) return "queued-turn";
  if (input.contextHandoffPending) return "context-handoff";
  if (input.checkpointRevertPending) return "checkpoint-revert";
  if (input.backgroundWorking) return "background-work";
  return null;
}

/** Short reason, for a disabled menu entry and the server's refusal. */
export function threadProjectMoveBlockerMessage(blocker: ThreadProjectMoveBlocker): string {
  switch (blocker) {
    case "thread-deleted":
      return "Deleted threads can't be moved";
    case "thread-archived":
      return "Unarchive the thread to move it";
    case "session-starting":
    case "session-running":
      return "Wait for the turn to finish, or stop it";
    case "background-work":
      return "Wait for its background work to finish";
    case "pending-approval":
      return "Answer the pending approval first";
    case "pending-user-input":
      return "Answer the pending question first";
    case "queued-turn":
      return "Wait for the message you sent to start";
    case "context-handoff":
      return "Wait for the model switch to finish";
    case "checkpoint-revert":
      return "Wait for the revert to finish";
  }
}
