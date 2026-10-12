/**
 * ThreadForkRepository - the chat fork ledger (`thread_forks`).
 *
 * One row per client fork key. Inserted once at acceptance; every later step is a
 * compare-and-set on `phase`, so exactly one owner advances a fork and a crashed run resumes
 * from the last recorded phase. Rows are never deleted: a settled one answers replays of its key.
 * Row and JSON column shapes live in `threadFork/forkLedger.ts`.
 *
 * @module ThreadForkRepository
 */
import { IsoDateTime, ThreadForkKey } from "@ryco/contracts";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import {
  ThreadForkLedgerPatch,
  ThreadForkLedgerRow,
  type ThreadForkLedgerState,
  ThreadForkPhase,
} from "../../threadFork/forkLedger.ts";
import type { ThreadForkRepositoryError } from "../Errors.ts";

export const GetThreadForkInput = Schema.Struct({ forkKey: ThreadForkKey });
export type GetThreadForkInput = typeof GetThreadForkInput.Type;

export const CompareAndSetThreadForkPhaseInput = Schema.Struct({
  forkKey: ThreadForkKey,
  expectedPhase: ThreadForkPhase,
  nextPhase: ThreadForkPhase,
  patch: ThreadForkLedgerPatch,
  /**
   * The row settles for good (completed, or failed without retry): drop the publication's
   * inherited messages, plans and activities from its plan. Replays only need its result.
   */
  releaseHistory: Schema.optional(Schema.Boolean),
  /**
   * Also require the row's `updated_at` to still be this value. A transition that keeps the
   * phase (a `failed` row settled again) cannot fence another writer by phase alone; every write
   * stamps a new `updated_at`, so a writer that read the row before another one changed it misses.
   */
  expectedUpdatedAt: Schema.optional(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type CompareAndSetThreadForkPhaseInput = typeof CompareAndSetThreadForkPhaseInput.Type;

export const ListRetryableFailedThreadForksInput = Schema.Struct({ updatedBefore: IsoDateTime });
export type ListRetryableFailedThreadForksInput = typeof ListRetryableFailedThreadForksInput.Type;

/** An unfinished row as the recovery sweep lists it: no plan or records are read. */
export const UnfinishedThreadFork = Schema.Struct({
  forkKey: ThreadForkKey,
  phase: ThreadForkPhase,
  updatedAt: IsoDateTime,
});
export type UnfinishedThreadFork = typeof UnfinishedThreadFork.Type;

export interface ThreadForkRepositoryShape {
  /** False when the key (or the derived fork thread id) already has a row; nothing is written. */
  readonly insertIfAbsent: (
    row: ThreadForkLedgerRow,
  ) => Effect.Effect<boolean, ThreadForkRepositoryError>;
  readonly getByKey: (
    input: GetThreadForkInput,
  ) => Effect.Effect<Option.Option<ThreadForkLedgerRow>, ThreadForkRepositoryError>;
  /** The row without its plan (and its inherited history), for answers that need no plan. */
  readonly getStateByKey: (
    input: GetThreadForkInput,
  ) => Effect.Effect<Option.Option<ThreadForkLedgerState>, ThreadForkRepositoryError>;
  /**
   * Moves the row from `expectedPhase` (and `expectedUpdatedAt`, when given) to `nextPhase` and
   * applies `patch` in one statement, and returns the row as written, without its (unchanged)
   * plan. None when another owner changed it first (or the row is gone); nothing is written then.
   */
  readonly compareAndSetPhase: (
    input: CompareAndSetThreadForkPhaseInput,
  ) => Effect.Effect<Option.Option<ThreadForkLedgerState>, ThreadForkRepositoryError>;
  /** Rows not yet `completed` or `failed`, oldest first, in full. */
  readonly listUnfinished: () => Effect.Effect<
    ReadonlyArray<ThreadForkLedgerRow>,
    ThreadForkRepositoryError
  >;
  /**
   * The keys, phases and last change of rows not yet `completed` or `failed`, oldest first: the
   * recovery sweep's work list. It reads the full row only for a key it then drives.
   */
  readonly listUnfinishedKeys: () => Effect.Effect<
    ReadonlyArray<UnfinishedThreadFork>,
    ThreadForkRepositoryError
  >;
  /** `failed` rows a client may still retry, last changed before `updatedBefore`, oldest first. */
  readonly listRetryableFailed: (
    input: ListRetryableFailedThreadForksInput,
  ) => Effect.Effect<ReadonlyArray<ThreadForkLedgerRow>, ThreadForkRepositoryError>;
}

export class ThreadForkRepository extends Context.Service<
  ThreadForkRepository,
  ThreadForkRepositoryShape
>()("ryco/persistence/Services/ThreadForks/ThreadForkRepository") {}
