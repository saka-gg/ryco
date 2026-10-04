/**
 * Pure checkpoint-revert policy shared by the decider (admission) and the
 * CheckpointReactor (re-check, journal). Lives outside `commandInvariants.ts`
 * so it can use `threadSettlementInput.ts` without an import cycle.
 */
import {
  CHECKPOINT_REVERT_ACTIVITY_KIND,
  CheckpointRevertActivityPayload,
  EventId,
  type CheckpointRevertFailureReason,
  type CheckpointRevertStatus,
  type CommandId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { hasQueuedTurnStart, type ThreadSettlementInput } from "@ryco/shared/threadSettlement";
import { Effect, Option, Schema } from "effect";

import { hasActionableContextHandoff } from "./commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { threadSettlementInput } from "./threadSettlementInput.ts";

/** Fail-open backstop: a pending revert older than this no longer blocks the thread. */
export const CHECKPOINT_REVERT_PENDING_STALE_MS = 10 * 60_000;

const PENDING_STATUSES: ReadonlySet<CheckpointRevertStatus> = new Set([
  "requested",
  "rolling-back",
  "restoring-files",
]);

export function isPendingCheckpointRevertStatus(status: CheckpointRevertStatus): boolean {
  return PENDING_STATUSES.has(status);
}

export function checkpointRevertActivityId(revertRequestId: CommandId | string): EventId {
  return EventId.make(`checkpoint-revert:${revertRequestId}`);
}

function checkpointRevertSummary(status: CheckpointRevertStatus, turnCount: number): string {
  switch (status) {
    case "requested":
    case "rolling-back":
    case "restoring-files":
      return `Reverting to checkpoint ${turnCount}`;
    case "completed":
      return `Reverted to checkpoint ${turnCount}`;
    case "files-not-restored":
      return "Reverted conversation; files were not restored";
    case "failed":
      return "Revert failed";
    case "interrupted":
      return "Revert interrupted";
  }
}

export function makeCheckpointRevertActivity(input: {
  readonly revertRequestId: CommandId;
  readonly turnCount: number;
  readonly fromTurnCount?: number | undefined;
  readonly status: CheckpointRevertStatus;
  readonly reason?: CheckpointRevertFailureReason | undefined;
  readonly detail?: string | undefined;
  readonly cwd?: string | undefined;
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  const detail = input.detail?.trim();
  const payload: CheckpointRevertActivityPayload = {
    schemaVersion: 1,
    revertRequestId: input.revertRequestId,
    turnCount: input.turnCount,
    ...(input.fromTurnCount !== undefined ? { fromTurnCount: input.fromTurnCount } : {}),
    status: input.status,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(detail ? { detail } : {}),
    ...(input.cwd !== undefined && input.cwd.trim().length > 0 ? { cwd: input.cwd } : {}),
  };
  return {
    id: checkpointRevertActivityId(input.revertRequestId),
    tone:
      isPendingCheckpointRevertStatus(input.status) || input.status === "completed"
        ? "info"
        : "error",
    kind: CHECKPOINT_REVERT_ACTIVITY_KIND,
    summary: checkpointRevertSummary(input.status, input.turnCount),
    payload,
    // Lifecycle activities carry no turn so the revert's own activity filter keeps them.
    turnId: null,
    createdAt: input.createdAt,
  };
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

const decodeRevertPayload = Schema.decodeUnknownOption(CheckpointRevertActivityPayload);

export interface CheckpointRevertEntry {
  readonly activity: OrchestrationThreadActivity;
  readonly payload: CheckpointRevertActivityPayload;
}

/** Newest `checkpoint.revert` activity, decoded. Undecodable payloads yield none. */
export function latestCheckpointRevert(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CheckpointRevertEntry | null {
  let latest: OrchestrationThreadActivity | null = null;
  for (const activity of activities) {
    if (activity.kind !== CHECKPOINT_REVERT_ACTIVITY_KIND) continue;
    if (latest === null || compareActivities(activity, latest) > 0) latest = activity;
  }
  if (latest === null) return null;
  const activity = latest;
  return Option.match(decodeRevertPayload(activity.payload), {
    onNone: () => null,
    onSome: (payload) => ({ activity, payload }),
  });
}

/**
 * Whether a thread's newest revert journal entry still blocks turn starts: pending and not
 * past the stale backstop. Callers that read the journal elsewhere (the delegated-return
 * worker reads `ProjectionSnapshotQuery.listPendingCheckpointReverts`) use this so they agree
 * with the decider's admission check.
 */
export function isCheckpointRevertEntryPending(
  entry: CheckpointRevertEntry,
  nowMs: number,
): boolean {
  if (!isPendingCheckpointRevertStatus(entry.payload.status)) return false;
  const createdAtMs = Date.parse(entry.activity.createdAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - createdAtMs < CHECKPOINT_REVERT_PENDING_STALE_MS;
}

export function isCheckpointRevertPending(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  nowMs: number,
): boolean {
  const latest = latestCheckpointRevert(activities);
  return latest !== null && isCheckpointRevertEntryPending(latest, nowMs);
}

export type ThreadBusyReason =
  | "session-starting"
  | "session-running"
  | "pending-approval"
  | "pending-user-input"
  | "queued-turn";

/** The single definition of "this thread cannot be reverted, or reverted around, now". */
export function threadBusyReason(input: ThreadSettlementInput): ThreadBusyReason | null {
  if (input.sessionStatus === "starting") return "session-starting";
  if (input.sessionStatus === "running" || input.latestTurnState === "running") {
    return "session-running";
  }
  if (input.hasPendingApprovals) return "pending-approval";
  if (input.hasPendingUserInput) return "pending-user-input";
  if (hasQueuedTurnStart(input)) return "queued-turn";
  return null;
}

export function threadBusyMessage(reason: ThreadBusyReason): string {
  switch (reason) {
    case "session-starting":
    case "session-running":
      return "This thread is still working. Wait for the turn to finish, or stop it, before reverting.";
    case "pending-approval":
      return "This thread is waiting for your approval. Answer it before reverting.";
    case "pending-user-input":
      return "This thread is waiting for your answer. Answer it before reverting.";
    case "queued-turn":
      return "A message you just sent is still starting. Wait for it to finish before reverting.";
  }
}

export function requireThreadReadyForCheckpointRevert(input: {
  readonly readModel: OrchestrationReadModel;
  readonly thread: OrchestrationThread;
  readonly command: Extract<OrchestrationCommand, { type: "thread.checkpoint.revert" }>;
  /**
   * Server time. Journal phases are server-stamped, so a client clock running
   * ahead must not age a pending revert out early.
   */
  readonly nowMs: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const { readModel, thread, command } = input;
  const fail = (detail: string) =>
    Effect.fail(new OrchestrationCommandInvariantError({ commandType: command.type, detail }));
  const busy = threadBusyReason(threadSettlementInput(readModel, thread, command.createdAt));
  if (busy !== null) return fail(threadBusyMessage(busy));
  if (hasActionableContextHandoff(thread)) {
    return fail("This thread is switching models. Wait for the switch to finish before reverting.");
  }
  if (isCheckpointRevertPending(thread.activities, input.nowMs)) {
    return fail("A revert is already in progress for this thread.");
  }
  return Effect.void;
}

export function requireNoPendingCheckpointRevert(input: {
  readonly thread: OrchestrationThread;
  readonly command: OrchestrationCommand;
  /** Server time, for the same reason as `requireThreadReadyForCheckpointRevert`. */
  readonly nowMs: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!isCheckpointRevertPending(input.thread.activities, input.nowMs)) {
    return Effect.void;
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail:
        "A checkpoint revert is in progress for this thread. Send your message when it finishes.",
    }),
  );
}
