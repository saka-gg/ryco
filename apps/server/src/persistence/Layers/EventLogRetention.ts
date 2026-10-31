/**
 * EventLogRetention - removes events no reader needs any more and raises replay floors.
 *
 * Event-log compaction (`EventLogCompaction.ts`) only removes events whose removal replays to the
 * same state. Retention removes events whose content the projections already hold, and records
 * that it did: every removal raises its stream's floor and the log's floor
 * (`orchestration_stream_floors`, in the same transaction), and a client that last applied a
 * sequence below a floor resumes from a snapshot instead of a replay with a gap
 * (`OrchestrationEventStore.probeResume`).
 *
 * Two kinds of removal, both bounded by the readers that still need old events:
 *
 * 1. A permanently deleted thread (its newest event is `thread.deleted`, its projection row
 *    deleted and not in Trash), `deletedThreadSettleMs` after the deletion: every event below the
 *    deletion. Its Statistics contribution is computed from the same rows Statistics reads and
 *    stored in `statistics_usage_rollups` in the transaction of the first removal, so Statistics
 *    keeps its usage. The `thread.deleted` event stays as the stream's newest (stream versions,
 *    shell resumes see the deletion, the thread.deleted projector's "created again later" check).
 * 2. A live (or trashed) thread: events older than `windowMs` that come before the start of its
 *    latest turn (that turn stays whole: restart continuations read its interrupts and steers,
 *    and it may still be running). Anchors stay: `thread.created`, `thread.deleted`, and every
 *    `context-window.updated` sample (Statistics reads each one; they are a tiny share of the log).
 *
 * Nothing is ever removed:
 * - at or above the oldest open provider effect intent (migration 073's retention contract: its
 *   startup recovery reads each open intent's request event),
 * - above the lowest projector cursor (every projector has applied it; a projector added later
 *   starts at 0 and would see the holes, see EventLogRetention.test.ts),
 * - above the compaction cursor (compaction's survivor checks only look forward),
 * - for a thread that an open completion return names (as child or parent) or that has a pending
 *   restart continuation: their readers join turn starts, stops and reverts in its stream.
 *
 * Each removal is one short transaction of at most `deleteBatch` events on the main connection,
 * followed by the pass's pause; the pass's time budget and `maxEventsPerPass` bound a pass.
 *
 * @module EventLogRetention
 */
import { Effect, type Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { ORCHESTRATION_PROJECTOR_NAMES } from "../../orchestration/projectorNames.ts";
import type {
  EventLogCompactionMode,
  EventLogRetentionOptions,
  RetentionPassResult,
  ThreadUsageReader,
} from "../Services/EventLogCompaction.ts";

/** The floor row of the whole log: shell resumes and replays across streams. */
export const LOG_FLOOR_AGGREGATE_KIND = "log";
export const LOG_FLOOR_STREAM_ID = "";

const ALL_PROJECTORS = JSON.stringify(Object.values(ORCHESTRATION_PROJECTOR_NAMES));

/** Events retention never removes from a live thread (see the module comment). */
export const RETENTION_ANCHOR_EVENT_TYPES = ["thread.created", "thread.deleted"] as const;

export interface RetentionPassInput {
  readonly options: EventLogRetentionOptions;
  readonly mode: EventLogCompactionMode;
  readonly nowMs: number;
  /** The compaction cursor after this pass's event phase: retention stays at or below it. */
  readonly compactedThroughSequence: number;
  readonly overTime: () => boolean;
  /** Runs after each delete transaction with its duration (the pass's pacing). */
  readonly afterBatch: (elapsedMs: number) => Effect.Effect<void>;
  /** Without it, deleted threads keep their events (their usage could not be rolled up). */
  readonly readThreadUsage: ThreadUsageReader | undefined;
}

interface Upper {
  readonly sequence: number;
}

/** The highest sequence any removal may reach, from the readers that span threads. */
const globalUpperBound = (sql: SqlClient.SqlClient, compactedThroughSequence: number) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly intentFloor: number | null;
      readonly projectors: number;
      readonly projected: number | null;
    }>`
      SELECT
        (SELECT MIN(sequence) FROM provider_effect_intents) AS "intentFloor",
        (
          SELECT COUNT(*) FROM projection_state
          WHERE projector IN (SELECT value FROM json_each(${ALL_PROJECTORS}))
        ) AS "projectors",
        (
          SELECT MIN(last_applied_sequence) FROM projection_state
          WHERE projector IN (SELECT value FROM json_each(${ALL_PROJECTORS}))
        ) AS "projected"
    `;
    const projectorCount = Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length;
    // A projector without a cursor has applied nothing yet.
    const projected =
      Number(row?.projectors ?? 0) < projectorCount ? 0 : Number(row?.projected ?? 0);
    const intentFloor =
      row?.intentFloor === null || row?.intentFloor === undefined
        ? Number.POSITIVE_INFINITY
        : Number(row.intentFloor) - 1;
    return Math.max(0, Math.min(projected, intentFloor, compactedThroughSequence));
  });

/** Largest sequence whose event is older than `cutoffIso` (0 when none); holes tolerated. */
const lastSequenceBefore = (sql: SqlClient.SqlClient, cutoffIso: string, head: number) =>
  Effect.gen(function* () {
    let lo = 0;
    let hi = head;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      const [row] = yield* sql<{ readonly sequence: number; readonly occurredAt: string | null }>`
        SELECT sequence, occurred_at AS "occurredAt" FROM orchestration_events
        WHERE sequence >= ${mid} AND sequence <= ${hi}
        ORDER BY sequence LIMIT 1
      `;
      if (row === undefined || row.occurredAt === null || !(row.occurredAt < cutoffIso)) {
        hi = mid - 1;
      } else {
        lo = Number(row.sequence);
      }
    }
    return lo;
  });

/** A thread that an open completion return or a pending restart continuation still reads. */
const threadIsHeld = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ readonly held: number }>`
      SELECT (
        EXISTS (
          SELECT 1 FROM agent_control_completion_returns
          WHERE status IN ('waiting', 'ready', 'dispatching')
            AND (
              child_thread_id = ${threadId}
              OR json_extract(record_json, '$.parentThreadId') = ${threadId}
            )
        )
        OR EXISTS (
          SELECT 1 FROM restart_continuations
          WHERE thread_id = ${threadId} AND status = 'pending'
        )
      ) AS held
    `;
    return Number(row?.held ?? 0) === 1;
  });

/** Raise a floor to `sequence` (never lower it). */
const raiseFloor = (
  sql: SqlClient.SqlClient,
  aggregateKind: string,
  streamId: string,
  sequence: number,
  nowIso: string,
) => sql`
  INSERT INTO orchestration_stream_floors (aggregate_kind, stream_id, floor_sequence, updated_at)
  VALUES (${aggregateKind}, ${streamId}, ${sequence}, ${nowIso})
  ON CONFLICT (aggregate_kind, stream_id) DO UPDATE SET
    floor_sequence = MAX(floor_sequence, excluded.floor_sequence),
    updated_at = excluded.updated_at
  WHERE excluded.floor_sequence > floor_sequence
`;

/** Bytes counted like compaction does (payload and metadata). */
const EVENT_BYTES = "length(CAST(payload_json AS BLOB)) + length(CAST(metadata_json AS BLOB))";

/**
 * The live-thread filter: old, and not an anchor. Deleted threads lose every event below their
 * deletion, so they use no filter.
 */
const liveThreadFilter = (sql: SqlClient.SqlClient, cutoffIso: string) => sql`
  AND occurred_at < ${cutoffIso}
  AND event_type NOT IN ${sql.in(RETENTION_ANCHOR_EVENT_TYPES)}
  AND NOT (
    event_type = 'thread.activity-appended'
    AND json_extract(payload_json, '$.activity.kind') = 'context-window.updated'
  )
`;

/** One thread that fails (a row Statistics cannot decode, a SQL error) never stops the pass. */
const skipThread = (threadId: string, error: unknown) =>
  Effect.logWarning("event log retention skipped a thread", { threadId, error }).pipe(
    Effect.as(false),
  );

export const runRetentionPass = (input: RetentionPassInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { options } = input;
    const deleting = input.mode === "delete";
    const nowIso = new Date(input.nowMs).toISOString();
    const deletedCutoffIso = new Date(input.nowMs - options.deletedThreadSettleMs).toISOString();
    const windowCutoffIso = new Date(input.nowMs - options.windowMs).toISOString();
    const batch = Math.max(1, Math.floor(options.deleteBatch));

    let deletedThreads = 0;
    let trimmedThreads = 0;
    let deletedEvents = 0;
    let deletedBytes = 0;
    let rollups = 0;
    let backlog = false;
    const overBudget = () => deletedEvents >= options.maxEventsPerPass || input.overTime();

    const upper = yield* globalUpperBound(sql, input.compactedThroughSequence);
    if (upper <= 0) {
      return { deletedThreads, trimmedThreads, deletedEvents, deletedBytes, rollups, backlog };
    }

    /**
     * Removes the stream's events at or below `bound` (with `filter`), batch by batch. `before`
     * runs at the start of the first transaction (the usage rollup). Returns whether every
     * matching event is gone.
     */
    const removeStreamEvents = (
      threadId: string,
      bound: Upper,
      filter: ReturnType<typeof liveThreadFilter> | null,
      before: Effect.Effect<void, SqlError | Schema.SchemaError> | null,
      stillValid: Effect.Effect<boolean, SqlError> | null = null,
    ) =>
      Effect.gen(function* () {
        const matching = sql`
          SELECT sequence FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND sequence <= ${bound.sequence}
            ${filter ?? sql``}
        `;
        if (!deleting) {
          const [counted] = yield* sql<{ readonly events: number; readonly bytes: number | null }>`
            SELECT count(*) AS events, SUM(${sql.literal(EVENT_BYTES)}) AS bytes
            FROM orchestration_events WHERE sequence IN (${matching})
          `;
          deletedEvents += Number(counted?.events ?? 0);
          deletedBytes += Number(counted?.bytes ?? 0);
          return Number(counted?.events ?? 0) > 0;
        }
        let first = true;
        let removedAny = false;
        while (true) {
          if (overBudget()) {
            backlog = true;
            return removedAny;
          }
          let startedAt = performance.now();
          const removed = yield* sql.withTransaction(
            Effect.gen(function* () {
              startedAt = performance.now();
              // Re-checked in every transaction: the selection ran before it, and the thread may
              // have changed since (a deleted id created again).
              if (stillValid !== null && !(yield* stillValid)) return null;
              if (first && before !== null) yield* before;
              // The floors rise before the rows go, in the same transaction.
              yield* raiseFloor(sql, "thread", threadId, bound.sequence, nowIso);
              yield* raiseFloor(
                sql,
                LOG_FLOOR_AGGREGATE_KIND,
                LOG_FLOOR_STREAM_ID,
                bound.sequence,
                nowIso,
              );
              return yield* sql<{ readonly bytes: number }>`
                DELETE FROM orchestration_events
                WHERE sequence IN (${matching} ORDER BY sequence LIMIT ${batch})
                RETURNING ${sql.literal(EVENT_BYTES)} AS bytes
              `;
            }),
          );
          first = false;
          const elapsedMs = performance.now() - startedAt;
          if (removed === null) return removedAny;
          for (const row of removed) deletedBytes += Number(row.bytes ?? 0);
          deletedEvents += removed.length;
          if (removed.length > 0) removedAny = true;
          yield* input.afterBatch(elapsedMs);
          if (removed.length < batch) return removedAny;
        }
      });

    // ── 1. Permanently deleted threads ─────────────────────────────────────
    // A thread whose newest event is its deletion, and one whose rollup exists but whose
    // removal a budget or an error stopped (also when its id was created again since: every
    // event below the deletion a rollup was taken at belongs to the rolled-up incarnation).
    const deleted = yield* sql<{
      readonly threadId: string;
      readonly head: number;
      readonly rolled: number;
    }>`
      SELECT t.thread_id AS "threadId", h.sequence AS "head", 0 AS "rolled"
      FROM projection_threads t
      JOIN orchestration_events h ON h.sequence = (
        SELECT MAX(e.sequence) FROM orchestration_events e
        WHERE e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id
      )
      WHERE t.deleted_at IS NOT NULL AND t.trashed_at IS NULL
        AND t.deleted_at <= ${deletedCutoffIso}
        AND h.event_type = 'thread.deleted'
        AND EXISTS (
          SELECT 1 FROM orchestration_events o
          WHERE o.aggregate_kind = 'thread' AND o.stream_id = t.thread_id
            AND o.sequence < h.sequence AND o.sequence <= ${upper}
        )
      UNION
      SELECT r.thread_id AS "threadId", MAX(r.deleted_sequence) AS "head", 1 AS "rolled"
      FROM statistics_usage_rollups r
      WHERE EXISTS (
        SELECT 1 FROM orchestration_events o
        WHERE o.aggregate_kind = 'thread' AND o.stream_id = r.thread_id
          AND o.sequence < r.deleted_sequence AND o.sequence <= ${upper}
      )
      GROUP BY r.thread_id
      ORDER BY "head"
    `;
    const readThreadUsage = input.readThreadUsage;
    const seen = new Set<string>();
    for (const candidate of readThreadUsage === undefined ? [] : deleted) {
      if (overBudget()) {
        backlog = true;
        break;
      }
      // Both selections can name a thread; the first (lowest head) wins this pass.
      if (seen.has(candidate.threadId)) continue;
      seen.add(candidate.threadId);
      const head = Number(candidate.head);
      const rolled = Number(candidate.rolled) === 1;
      const rollup: Effect.Effect<void, SqlError | Schema.SchemaError> = Effect.gen(function* () {
        const [existing] = yield* sql<{ readonly found: number }>`
          SELECT 1 AS found FROM statistics_usage_rollups
          WHERE thread_id = ${candidate.threadId} AND deleted_sequence = ${head}
        `;
        if (existing !== undefined) return;
        // Computed in the transaction that removes the first events: from every row Statistics
        // would read, never from a partly removed stream.
        const partial = yield* readThreadUsage!(sql, candidate.threadId);
        yield* sql`
          INSERT INTO statistics_usage_rollups (thread_id, deleted_sequence, partial_json, rolled_at)
          VALUES (${candidate.threadId}, ${head}, ${JSON.stringify(partial)}, ${nowIso})
        `;
        rollups += 1;
      });
      // Before the rollup exists, the deletion must still be the stream's newest event.
      const stillDeleted = sql<{ readonly ok: number }>`
        SELECT (
          (SELECT MAX(sequence) FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${candidate.threadId}) = ${head}
          AND (SELECT event_type FROM orchestration_events WHERE sequence = ${head})
            = 'thread.deleted'
        ) AS ok
      `.pipe(Effect.map((rows) => Number(rows[0]?.ok ?? 0) === 1));
      const removed = yield* Effect.gen(function* () {
        if (yield* threadIsHeld(sql, candidate.threadId)) return false;
        return yield* removeStreamEvents(
          candidate.threadId,
          { sequence: Math.min(head - 1, upper) },
          null,
          rolled ? null : rollup,
          rolled ? null : stillDeleted,
        );
      }).pipe(Effect.catch((error) => skipThread(candidate.threadId, error)));
      if (removed) deletedThreads += 1;
    }

    // ── 2. Old events of live threads ──────────────────────────────────────
    if (!backlog) {
      const [headRow] = yield* sql<{ readonly head: number | null }>`
        SELECT MAX(sequence) AS head FROM orchestration_events
      `;
      const windowUpper = Math.min(
        upper,
        yield* lastSequenceBefore(sql, windowCutoffIso, Number(headRow?.head ?? 0)),
      );
      if (windowUpper > 0) {
        // Each thread's bound: before its latest turn, within the window. A thread whose floor
        // already reaches its bound has nothing left to remove until a new turn starts.
        const live = yield* sql<{
          readonly threadId: string;
          readonly bound: number;
        }>`
          WITH live AS (
            SELECT
              t.thread_id AS thread_id,
              MIN(
                ${windowUpper},
                (
                  SELECT e.sequence FROM orchestration_events e
                  WHERE e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id
                    AND e.event_type = 'thread.turn-start-requested'
                  ORDER BY e.sequence DESC LIMIT 1
                ) - 1
              ) AS bound,
              COALESCE((
                SELECT f.floor_sequence FROM orchestration_stream_floors f
                WHERE f.aggregate_kind = 'thread' AND f.stream_id = t.thread_id
              ), 0) AS floor
            FROM projection_threads t
            WHERE t.deleted_at IS NULL OR t.trashed_at IS NOT NULL
          )
          SELECT thread_id AS "threadId", bound
          FROM live
          WHERE bound IS NOT NULL AND bound > floor
            AND EXISTS (
              SELECT 1 FROM orchestration_events o
              WHERE o.aggregate_kind = 'thread' AND o.stream_id = live.thread_id
                AND o.sequence > live.floor AND o.sequence <= live.bound
                ${liveThreadFilter(sql, windowCutoffIso)}
            )
          ORDER BY bound
        `;
        for (const candidate of live) {
          if (overBudget()) {
            backlog = true;
            break;
          }
          const removed = yield* Effect.gen(function* () {
            if (yield* threadIsHeld(sql, candidate.threadId)) return false;
            return yield* removeStreamEvents(
              candidate.threadId,
              { sequence: Number(candidate.bound) },
              liveThreadFilter(sql, windowCutoffIso),
              null,
            );
          }).pipe(Effect.catch((error) => skipThread(candidate.threadId, error)));
          if (removed) trimmedThreads += 1;
        }
      }
    }

    return {
      deletedThreads,
      trimmedThreads,
      deletedEvents,
      deletedBytes,
      rollups,
      backlog,
    } satisfies RetentionPassResult;
  });
