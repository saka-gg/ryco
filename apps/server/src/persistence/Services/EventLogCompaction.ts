/**
 * EventLogCompaction - removes superseded latest-state activity events from the event log and
 * prunes old command receipts whose ids can never be dispatched again.
 *
 * What is removed, and why replay stays equivalent, is defined once in
 * `@ryco/shared/latestStateActivities`. The layer (`Layers/EventLogCompaction.ts`) documents the
 * pass itself: horizon, budgets, batching and the state it keeps in `lifecycle_markers`.
 *
 * @module EventLogCompaction
 */
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/** `delete` removes events; `dry-run` selects and counts only, under its own state. */
export type EventLogCompactionMode = "delete" | "dry-run";

/**
 * `settled`: only events whose `occurred_at` is at least `settleAgeMs` old (online). `head`: the
 * whole log (offline, while no server runs).
 */
export type EventLogCompactionHorizon = "settled" | "head";

export interface EventLogCompactionDeleteBatch {
  readonly initial: number;
  readonly min: number;
  readonly max: number;
  /** Target duration of one delete transaction on the main connection. */
  readonly targetMs: number;
}

export interface EventLogCompactionReceiptOptions {
  /** Receipts accepted longer ago than this may be pruned (only random-id ones). */
  readonly cutoffMs: number;
  readonly pageRows: number;
  readonly deleteBatch: number;
  /** Receipts examined per pass at most. */
  readonly maxScanRows: number;
}

export interface CompactionProgress {
  readonly horizonSequence: number;
  readonly compactedThroughSequence: number;
  readonly scannedSequences: number;
  readonly deletedEvents: number;
  readonly deletedBytes: number;
}

export interface EventLogCompactionPassOptions {
  readonly horizon: EventLogCompactionHorizon;
  readonly settleAgeMs: number;
  /** Sequences examined per pass at most (`Infinity` offline). */
  readonly maxScanSequences: number;
  /** Wall-clock budget of a pass (`Infinity` offline); checked between windows and pages. */
  readonly maxWallMs: number;
  /**
   * Sequences per selection window (one read, then that window's deletes). Capped at 500 when
   * selection runs on the main connection (no read worker), where it blocks the event loop.
   */
  readonly selectionPageSequences: number;
  readonly deleteBatch: EventLogCompactionDeleteBatch;
  /** Shortest pause between delete transactions, so other work on the event loop runs. */
  readonly interBatchPauseMs: number;
  /**
   * The pause after a delete transaction is also at least this many times its duration (online 3:
   * the main connection spends at most a quarter of a pass deleting). 0 or absent: no such pause.
   */
  readonly idleRatio?: number;
  /** Keys whose newest version is remembered across windows (LRU); eviction only deletes less. */
  readonly carryCapacity: number;
  readonly receipts: EventLogCompactionReceiptOptions | null;
  readonly mode: EventLogCompactionMode;
  /**
   * Start at sequence 0 instead of the stored cursor. An offline pass uses it to remove what
   * online passes leave behind: the carry starts empty each pass, so one superseded version per
   * key whose versions straddle two passes stays in the log.
   */
  readonly fromBeginning?: boolean;
  /** Write no state (a read-only connection). Implies selection only. */
  readonly persistState?: boolean;
  readonly onProgress?: (progress: CompactionProgress) => Effect.Effect<void>;
}

const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const CompactionTotals = Schema.Struct({
  scannedSequences: NonNegativeNumber,
  deletedEvents: NonNegativeNumber,
  deletedBytes: NonNegativeNumber,
  deletedReceipts: NonNegativeNumber,
});
export type CompactionTotals = typeof CompactionTotals.Type;

export const CompactionLastPass = Schema.Struct({
  scannedSequences: NonNegativeNumber,
  deletedEvents: NonNegativeNumber,
  deletedBytes: NonNegativeNumber,
  deletedReceipts: NonNegativeNumber,
  maxBatchMs: NonNegativeNumber,
  mainThreadMs: NonNegativeNumber,
  durationMs: NonNegativeNumber,
  horizon: NonNegativeNumber,
  backlogSequences: NonNegativeNumber,
  /** Old receipts may still be waiting (a restart resumes the catch-up cadence for them too). */
  receiptBacklog: Schema.Boolean,
});
export type CompactionLastPass = typeof CompactionLastPass.Type;

/** Stored as JSON in `lifecycle_markers`; an undecodable value starts over from 0 (safe). */
export const CompactionState = Schema.Struct({
  version: Schema.Literal(1),
  compactedThroughSequence: NonNegativeNumber,
  receiptRowidCursor: NonNegativeNumber,
  lastPassStartedAt: Schema.NullOr(Schema.String),
  lastPassCompletedAt: Schema.NullOr(Schema.String),
  totals: CompactionTotals,
  lastPass: Schema.NullOr(CompactionLastPass),
});
export type CompactionState = typeof CompactionState.Type;

export const EMPTY_COMPACTION_STATE: CompactionState = {
  version: 1,
  compactedThroughSequence: 0,
  receiptRowidCursor: 0,
  lastPassStartedAt: null,
  lastPassCompletedAt: null,
  totals: { scannedSequences: 0, deletedEvents: 0, deletedBytes: 0, deletedReceipts: 0 },
  lastPass: null,
};

export type CompactionStopReason = "complete" | "scan-budget" | "time-budget";

export interface CompactionPassResult {
  readonly mode: EventLogCompactionMode;
  readonly horizon: EventLogCompactionHorizon;
  /** Largest sequence this pass may touch. */
  readonly horizonSequence: number;
  readonly headSequence: number;
  readonly startSequence: number;
  readonly compactedThroughSequence: number;
  /** Settled sequences still to scan (`horizonSequence - compactedThroughSequence`). */
  readonly backlogSequences: number;
  readonly scannedSequences: number;
  readonly selectedEvents: number;
  readonly deletedEvents: number;
  readonly deletedBytes: number;
  /** Batches skipped because a survivor was gone (never expected; logged). */
  readonly skippedBatches: number;
  readonly scannedReceipts: number;
  readonly deletedReceipts: number;
  /**
   * Old receipts may still be waiting: a budget stopped the receipt walk before its end, or the
   * event phase stopped at one before the walk began. False when receipts are disabled.
   */
  readonly receiptBacklog: boolean;
  readonly durationMs: number;
  /** Time spent in statements on the main connection (and selection when it ran there). */
  readonly mainThreadMs: number;
  readonly maxBatchMs: number;
  /** Duration of each event delete transaction, in order (for measurements). */
  readonly batchDurationsMs: ReadonlyArray<number>;
  /** Duration of each receipt delete transaction, in order (for measurements). */
  readonly receiptBatchDurationsMs: ReadonlyArray<number>;
  readonly stopReason: CompactionStopReason;
}

export interface EventLogCompactionShape {
  /** One pass; passes never overlap (a second caller waits). */
  readonly runPass: (
    options: EventLogCompactionPassOptions,
  ) => Effect.Effect<CompactionPassResult, PersistenceSqlError>;
  /** The stored state of a mode; the empty state when none (or an undecodable one) is stored. */
  readonly readState: (
    mode: EventLogCompactionMode,
  ) => Effect.Effect<CompactionState, PersistenceSqlError>;
}

export class EventLogCompaction extends Context.Service<
  EventLogCompaction,
  EventLogCompactionShape
>()("ryco/persistence/Services/EventLogCompaction") {}
