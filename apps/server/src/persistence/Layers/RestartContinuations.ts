/**
 * RestartContinuationRepository - the restart continuation ledger and graceful
 * shutdown hints (migration 073).
 *
 * One row per (thread, source turn) a restart cut off. Rows are inserted once at
 * capture and leave `pending` exactly once (`settle` is a compare-and-set on
 * `pending`), so a dispatch pass always terminates and an earlier decision wins.
 *
 * @module RestartContinuationRepository
 */
import {
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type {
  RestartContinuationKind,
  RestartContinuationStatus,
  RestartSourceTurnSignals,
} from "../../orchestration/restartContinuationPolicy.ts";

export const RestartBackgroundWorkRecord = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })).check(
    Schema.isMaxLength(10),
  ),
  omitted: NonNegativeInt,
  detailsOmitted: Schema.Boolean,
});
export type RestartBackgroundWorkRecord = typeof RestartBackgroundWorkRecord.Type;

/** Server-internal; never part of contracts. Everything dispatch needs without re-reading. */
export const RestartContinuationRecord = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["in-flight", "background-only"]),
  threadId: ThreadId,
  sourceTurnId: TurnId,
  latestUserMessageId: Schema.NullOr(MessageId),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePath: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  providerInstanceId: ProviderInstanceId,
  runtimeSessionId: Schema.NullOr(RuntimeSessionId),
  backgroundWork: RestartBackgroundWorkRecord,
  capturedAt: IsoDateTime,
  lastObservedAt: IsoDateTime,
});
export type RestartContinuationRecord = typeof RestartContinuationRecord.Type;

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(RestartContinuationRecord));
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RestartContinuationRecord));

export interface RestartContinuationRow {
  readonly record: RestartContinuationRecord;
  readonly status: RestartContinuationStatus;
  readonly reason: string | null;
  readonly settledAt: string | null;
}

/** A stored row whose record no longer decodes; settled `failed: invalid-record` by the caller. */
export interface InvalidRestartContinuationRow {
  readonly invalid: true;
  readonly threadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly status: RestartContinuationStatus;
  readonly reason: string | null;
}

export type StoredRestartContinuation =
  | (RestartContinuationRow & { readonly invalid?: false })
  | InvalidRestartContinuationRow;

export interface RestartShutdownHintRow {
  readonly threadId: ThreadId;
  readonly hasBackgroundWork: boolean;
  readonly recordedAt: string;
}

interface DbRow {
  readonly threadId: string;
  readonly sourceTurnId: string;
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly settledAt: string | null;
  readonly record: string;
}

const ROW_COLUMNS = `
  thread_id AS "threadId",
  source_turn_id AS "sourceTurnId",
  kind,
  status,
  reason,
  settled_at AS "settledAt",
  record_json AS record
`;

function readRow(row: DbRow): StoredRestartContinuation {
  const status = row.status as RestartContinuationStatus;
  const decoded = decodeRecord(row.record);
  if (
    Option.isNone(decoded) ||
    decoded.value.threadId !== row.threadId ||
    decoded.value.sourceTurnId !== row.sourceTurnId ||
    decoded.value.kind !== (row.kind as RestartContinuationKind)
  ) {
    return {
      invalid: true,
      threadId: ThreadId.make(row.threadId),
      sourceTurnId: TurnId.make(row.sourceTurnId),
      status,
      reason: row.reason,
    };
  }
  return { record: decoded.value, status, reason: row.reason, settledAt: row.settledAt };
}

export const makeRestartContinuationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(ROW_COLUMNS);
  const safe =
    (operation: string) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(toPersistenceSqlError(`RestartContinuations.${operation}`)));

  /** Inserts the row unless one exists for (thread, source turn); true when inserted. */
  const insertIfAbsent = (row: RestartContinuationRow) =>
    sql<{ readonly threadId: string }>`
      INSERT INTO restart_continuations (
        thread_id, source_turn_id, kind, status, reason,
        captured_at, last_observed_at, settled_at, record_json
      )
      VALUES (
        ${row.record.threadId}, ${row.record.sourceTurnId}, ${row.record.kind}, ${row.status},
        ${row.reason}, ${row.record.capturedAt}, ${row.record.lastObservedAt}, ${row.settledAt},
        ${encodeRecord(row.record)}
      )
      ON CONFLICT (thread_id, source_turn_id) DO NOTHING
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      safe("insertIfAbsent"),
    );

  const get = (input: { readonly threadId: ThreadId; readonly sourceTurnId: TurnId }) =>
    sql<DbRow>`
      SELECT ${columns} FROM restart_continuations
      WHERE thread_id = ${input.threadId} AND source_turn_id = ${input.sourceTurnId}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(readRow))),
      safe("get"),
    );

  /** Pending rows, most recently observed first (the pending index order). */
  const listPending = (limit: number) =>
    sql<DbRow>`
      SELECT ${columns} FROM restart_continuations
      WHERE status = 'pending'
      ORDER BY last_observed_at DESC, thread_id, source_turn_id
      LIMIT ${Math.max(1, Math.floor(limit))}
    `.pipe(
      Effect.map((rows) => rows.map(readRow)),
      safe("listPending"),
    );

  /** Moves a pending row to its final status; false when it already left `pending`. */
  const settle = (input: {
    readonly threadId: ThreadId;
    readonly sourceTurnId: TurnId;
    readonly status: Exclude<RestartContinuationStatus, "pending">;
    readonly reason: string | null;
    readonly settledAt: string;
  }) =>
    sql<{ readonly threadId: string }>`
      UPDATE restart_continuations
      SET status = ${input.status}, reason = ${input.reason}, settled_at = ${input.settledAt}
      WHERE thread_id = ${input.threadId}
        AND source_turn_id = ${input.sourceTurnId}
        AND status = 'pending'
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      safe("settle"),
    );

  /**
   * Event-log facts about one source turn, read from the thread's own stream
   * (`idx_orch_events_stream_sequence`). A read-only exception to the event store owning
   * `orchestration_events`: the projections cannot tell a stopped turn from a running
   * one (a later session-set flips `interrupted` back to `running`), so the stop signal
   * is the request itself. Only runs for restart capture candidates.
   *
   * - `interruptRequested`: a non-provider interrupt request for the turn (user Stops and
   *   Agent Control interrupts are client actors).
   * - `unresolvedSteer`: a steer aimed at the turn without an accepted/rejected outcome.
   * - `computerUse`: the turn's own start requested computer control.
   */
  const sourceTurnSignals = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly turnMessageId: MessageId | null;
  }) =>
    sql<{
      readonly interruptRequested: number;
      readonly unresolvedSteer: number;
      readonly computerUse: number;
    }>`
      SELECT
        EXISTS (
          SELECT 1 FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
            AND event_type = 'thread.turn-interrupt-requested'
            AND actor_kind <> 'provider'
            AND json_extract(payload_json, '$.turnId') = ${input.turnId}
        ) AS "interruptRequested",
        EXISTS (
          SELECT 1 FROM orchestration_events steer
          WHERE steer.aggregate_kind = 'thread' AND steer.stream_id = ${input.threadId}
            AND steer.event_type = 'thread.turn-steer-requested'
            AND json_extract(steer.payload_json, '$.expectedTurnId') = ${input.turnId}
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_events resolved
              WHERE resolved.aggregate_kind = 'thread' AND resolved.stream_id = ${input.threadId}
                AND resolved.event_type IN (
                  'thread.turn-steer-accepted',
                  'thread.turn-steer-rejected'
                )
                AND json_extract(resolved.payload_json, '$.messageId')
                  = json_extract(steer.payload_json, '$.message.messageId')
            )
        ) AS "unresolvedSteer",
        EXISTS (
          SELECT 1 FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
            AND event_type = 'thread.turn-start-requested'
            AND json_extract(payload_json, '$.messageId') = ${input.turnMessageId}
            AND json_type(payload_json, '$.computerUse') = 'object'
        ) AS "computerUse"
    `.pipe(
      Effect.map((rows): RestartSourceTurnSignals => ({
        interruptRequested: Number(rows[0]?.interruptRequested ?? 0) > 0,
        unresolvedSteer: Number(rows[0]?.unresolvedSteer ?? 0) > 0,
        computerUse: Number(rows[0]?.computerUse ?? 0) > 0,
      })),
      safe("sourceTurnSignals"),
    );

  /** A committed turn start for the message that never bound a turn. */
  const pendingTurnStartExists = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) =>
    sql`
      SELECT 1 FROM projection_turns
      WHERE thread_id = ${input.threadId} AND turn_id IS NULL
        AND pending_message_id = ${input.messageId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      safe("pendingTurnStartExists"),
    );

  /**
   * At a graceful shutdown, in one transaction: every thread this process has a live
   * provider session for whose projected session still runs (or names an active turn),
   * and every thread with live background work. A hint is evidence that this process ran
   * the work up to now, so a projected session the process never ran (an orphan of an
   * earlier crash it did not reconcile) is never hinted: its hint would restart the
   * freshness clock of work that died long ago.
   *
   * An existing hint (one no capture consumed yet) keeps its earlier time, so a re-hint can
   * never make work look newer than an earlier shutdown did. Capture still takes the later
   * of a hint and the projection's own evidence, since a hint names the thread, not a turn.
   */
  const recordShutdownHints = (input: {
    readonly liveSessionThreadIds: ReadonlyArray<string>;
    readonly liveBackgroundThreadIds: ReadonlyArray<string>;
    readonly recordedAt: string;
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const threadId of new Set(input.liveSessionThreadIds)) {
            yield* sql`
              INSERT INTO restart_shutdown_hints (thread_id, has_background_work, recorded_at)
              SELECT thread_id, 0, ${input.recordedAt} FROM projection_thread_sessions
              WHERE thread_id = ${threadId}
                AND (status IN ('running', 'starting') OR active_turn_id IS NOT NULL)
              ON CONFLICT (thread_id) DO UPDATE SET
                recorded_at = MIN(recorded_at, excluded.recorded_at)
            `;
          }
          for (const threadId of new Set(input.liveBackgroundThreadIds)) {
            yield* sql`
              INSERT INTO restart_shutdown_hints (thread_id, has_background_work, recorded_at)
              VALUES (${threadId}, 1, ${input.recordedAt})
              ON CONFLICT (thread_id) DO UPDATE SET
                has_background_work = 1,
                recorded_at = MIN(recorded_at, excluded.recorded_at)
            `;
          }
        }),
      )
      .pipe(safe("recordShutdownHints"));

  const listShutdownHints = () =>
    sql<{
      readonly threadId: string;
      readonly hasBackgroundWork: number;
      readonly recordedAt: string;
    }>`
      SELECT thread_id AS "threadId", has_background_work AS "hasBackgroundWork",
        recorded_at AS "recordedAt"
      FROM restart_shutdown_hints
      ORDER BY thread_id
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): RestartShutdownHintRow => ({
          threadId: ThreadId.make(row.threadId),
          hasBackgroundWork: Number(row.hasBackgroundWork) > 0,
          recordedAt: row.recordedAt,
        })),
      ),
      safe("listShutdownHints"),
    );

  /** Removes hints recorded at or before the cutoff (the ones a capture consumed). */
  const clearShutdownHints = (recordedAtOrBefore: string) =>
    sql`DELETE FROM restart_shutdown_hints WHERE recorded_at <= ${recordedAtOrBefore}`.pipe(
      Effect.asVoid,
      safe("clearShutdownHints"),
    );

  /** Drops settled rows older than the cutoff; pending rows are never pruned. */
  const pruneSettled = (before: string) =>
    sql`
      DELETE FROM restart_continuations WHERE status <> 'pending' AND settled_at < ${before}
    `.pipe(Effect.asVoid, safe("pruneSettled"));

  return {
    insertIfAbsent,
    get,
    listPending,
    settle,
    sourceTurnSignals,
    pendingTurnStartExists,
    recordShutdownHints,
    listShutdownHints,
    clearShutdownHints,
    pruneSettled,
  };
});

export class RestartContinuationRepository extends Context.Service<
  RestartContinuationRepository,
  Effect.Success<typeof makeRestartContinuationRepository>
>()("ryco/persistence/RestartContinuationRepository") {}

export const RestartContinuationRepositoryLive = Layer.effect(
  RestartContinuationRepository,
  makeRestartContinuationRepository,
);
