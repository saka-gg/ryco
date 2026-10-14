import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Live progress of the worktree a first send prepares before its turn starts.
 *
 * The node publishes it while `thread.turn.start` bootstraps a new worktree:
 * the base fetch, the checkout, the project's setup script and the hand-off to
 * the agent. It is a presentation feed held in memory only; the durable record
 * of the outcome stays the thread and its events.
 */
export const WorktreeSetupStageId = Schema.Literals(["fetch", "checkout", "setup-script", "agent"]);
export type WorktreeSetupStageId = typeof WorktreeSetupStageId.Type;

/** The stages every setup lists, in order, so a view can render all rows up front. */
export const WORKTREE_SETUP_STAGE_IDS: ReadonlyArray<WorktreeSetupStageId> = [
  "fetch",
  "checkout",
  "setup-script",
  "agent",
];

export const WorktreeSetupStageStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
]);
export type WorktreeSetupStageStatus = typeof WorktreeSetupStageStatus.Type;

export const WorktreeSetupStage = Schema.Struct({
  id: WorktreeSetupStageId,
  status: WorktreeSetupStageStatus,
  startedAt: Schema.optional(IsoDateTime),
  finishedAt: Schema.optional(IsoDateTime),
  /** Checkout progress as Git reports it (0-100). */
  percent: Schema.optional(Schema.Number),
  /**
   * A short qualifier: `prefetched` when the fetch reused the composer's
   * prefetch, the setup script's name for `setup-script`.
   */
  detail: Schema.optional(Schema.String),
});
export type WorktreeSetupStage = typeof WorktreeSetupStage.Type;

/**
 * `done` means the turn was dispatched; the setup script can still be running
 * then (it never blocks the agent), so its stage and the output tail keep
 * updating until it goes idle.
 */
export const WorktreeSetupStatus = Schema.Literals(["running", "done", "failed", "cancelled"]);
export type WorktreeSetupStatus = typeof WorktreeSetupStatus.Type;

/** At most this many trailing lines of setup-script output travel in a snapshot. */
export const WORKTREE_SETUP_OUTPUT_TAIL_LINES = 4;

export const WorktreeSetupSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** Increases with every published change of this setup. */
  sequence: NonNegativeInt,
  status: WorktreeSetupStatus,
  /** The base the worktree branches from, as the send named it (`origin/main`). */
  baseRef: TrimmedNonEmptyString,
  /** The new branch, once known. */
  branch: Schema.optional(TrimmedNonEmptyString),
  /** The checkout, once Git created it. */
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  /** The terminal the setup script runs in, for "open terminal". */
  setupTerminalId: Schema.optional(TrimmedNonEmptyString),
  stages: Schema.Array(WorktreeSetupStage),
  /** The setup script's last lines of output, ANSI-stripped. */
  outputTail: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorktreeSetupSnapshot = typeof WorktreeSetupSnapshot.Type;

export const WorktreeSetupSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type WorktreeSetupSubscribeInput = typeof WorktreeSetupSubscribeInput.Type;

export const WorktreeSetupCancelInput = Schema.Struct({
  threadId: ThreadId,
});
export type WorktreeSetupCancelInput = typeof WorktreeSetupCancelInput.Type;

/** The send's failure message when the user stopped the setup. */
export const WORKTREE_SETUP_CANCELLED_MESSAGE = "Worktree setup cancelled.";

export const WorktreeSetupCancelResult = Schema.Struct({
  /** False when no setup for this thread was still cancellable. */
  cancelled: Schema.Boolean,
});
export type WorktreeSetupCancelResult = typeof WorktreeSetupCancelResult.Type;
