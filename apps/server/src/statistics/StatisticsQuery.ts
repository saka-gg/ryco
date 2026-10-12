/**
 * StatisticsQuery - usage analytics over the orchestration projection tables.
 *
 * Aggregates the existing read models (threads, sessions, token-usage
 * activities, turns/checkpoints, worktrees) into a {@link StatisticsSnapshot}
 * on demand. No dedicated statistics tables exist; everything is derived from
 * data already persisted by the projection pipeline.
 *
 * Processed billing counters are read from indexed activity event history, with
 * projection-only/imported rows as a fallback. Session counters are differenced;
 * turn and request counters retain their final snapshots. Context-window gauges
 * remain a best-effort fallback for older/provider-limited data.
 *
 * The node:sqlite client is synchronous and owns one connection, so every row
 * read here stalls the event loop and every other reader/writer. Reads are kept
 * minimal: per-thread partial aggregates are cached in memory and only threads
 * with new orchestration events are re-read (see {@link StatisticsState}). Rows
 * are read in one transaction, then decoded and aggregated after it commits.
 *
 * A fork's inherited turns and activities are display copies of its source's history: the work
 * is already counted once, on the source, so every reader here leaves them out.
 *
 * @module StatisticsQuery
 */
import { type StatisticsSnapshot } from "@ryco/contracts";
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  inheritedActivityRowSql,
  inheritedItemIdSql,
  inheritedTurnRowSql,
} from "../orchestration/forkInheritanceSql.ts";
import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/Layers/ProjectionPipeline.ts";
import {
  assembleStatisticsSnapshot,
  buildStatisticsThreadMeta,
  computeStatisticsThreadPartial,
  groupStatisticsRowsByThread,
  StatisticsProjectRow,
  StatisticsThreadRow,
  StatisticsTokenActivityRow,
  StatisticsToolUseRow,
  StatisticsTurnRow,
  StatisticsWorktreeRow,
  statisticsThreadMetaKey,
  type StatisticsThreadPartial,
} from "./statisticsAggregation.ts";

/**
 * StatisticsQueryShape - service API.
 */
export interface StatisticsQueryShape {
  readonly getStatistics: () => Effect.Effect<StatisticsSnapshot, ProjectionRepositoryError>;
}

/**
 * StatisticsQuery - service tag.
 */
export class StatisticsQuery extends Context.Service<StatisticsQuery, StatisticsQueryShape>()(
  "ryco/statistics/StatisticsQuery",
) {}

/** Projectors that write the thread-scoped rows a partial is computed from. */
const THREAD_SCOPED_PROJECTORS = JSON.stringify([
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
]);

/** Above this many changed threads a full read is as cheap as a scoped one. */
const INCREMENTAL_THREAD_LIMIT = 256;
/** Yield to other fibers between aggregation chunks of this many threads. */
const AGGREGATION_CHUNK_THREADS = 256;

/**
 * Context-window token activities: durable event history first, then projection
 * rows that have no event (imported/projection-only). `scope` is a JSON array
 * of thread ids, or `null` for every thread.
 *
 * In the NOT EXISTS lookup the `+` operators strip the TEXT column affinity of
 * `a.activity_id`/`a.created_at`. Without them SQLite cannot use the expression
 * columns of idx_orch_events_statistics_usage and rescans the thread's events,
 * re-extracting JSON, once per projection row.
 */
export function selectStatisticsTokenActivities(sql: SqlClient.SqlClient, scope: string | null) {
  return sql`
    SELECT
      stream_id AS "threadId",
      json_extract(payload_json, '$.activity.turnId') AS "turnId",
      COALESCE(json_extract(payload_json, '$.activity.sequence'), sequence) AS sequence,
      json_extract(payload_json, '$.activity.createdAt') AS "createdAt",
      json_extract(payload_json, '$.activity.payload') AS "payloadJson"
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') = 'context-window.updated'
      ${scope === null ? sql`` : sql`AND stream_id IN (SELECT value FROM json_each(${scope}))`}
      AND NOT ${inheritedItemIdSql(
        sql,
        sql.literal("json_extract(payload_json, '$.activity.id')"),
        sql.literal("stream_id"),
      )}
    UNION ALL
    SELECT
      thread_id AS "threadId", turn_id AS "turnId", sequence,
      created_at AS "createdAt", payload_json AS "payloadJson"
    FROM projection_thread_activities a
    WHERE kind = 'context-window.updated'
      ${scope === null ? sql`` : sql`AND a.thread_id IN (SELECT value FROM json_each(${scope}))`}
      AND NOT ${inheritedActivityRowSql(sql, "a")}
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events e
        WHERE e.event_type = 'thread.activity-appended'
          AND json_extract(e.payload_json, '$.activity.kind') = 'context-window.updated'
          AND e.stream_id = a.thread_id
          AND json_extract(e.payload_json, '$.activity.id') = +a.activity_id
          AND json_extract(e.payload_json, '$.activity.createdAt') = +a.created_at
      )
    ORDER BY "threadId", "createdAt", sequence
  `;
}

/** Completed tool calls per (thread, UTC day). See {@link selectStatisticsTokenActivities} for `scope`. */
export function selectStatisticsToolUses(sql: SqlClient.SqlClient, scope: string | null) {
  return sql`
    SELECT
      thread_id AS "threadId",
      substr(created_at, 1, 10) AS "date",
      COUNT(*) AS "count"
    FROM projection_thread_activities
    WHERE kind = 'tool.completed'
      ${scope === null ? sql`` : sql`AND thread_id IN (SELECT value FROM json_each(${scope}))`}
      AND NOT ${inheritedActivityRowSql(sql, "projection_thread_activities")}
    GROUP BY thread_id, substr(created_at, 1, 10)
  `;
}

function selectStatisticsTurns(sql: SqlClient.SqlClient, scope: string | null) {
  return sql`
    SELECT
      thread_id AS "threadId",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      checkpoint_turn_count AS "checkpointTurnCount",
      checkpoint_files_json AS "filesJson"
    FROM projection_turns turns
    WHERE NOT ${inheritedTurnRowSql(sql, "turns")}
      ${scope === null ? sql`` : sql`AND thread_id IN (SELECT value FROM json_each(${scope}))`}
  `;
}

interface StatisticsRevision {
  /** Writes on this connection. Never reset by a rollback. */
  readonly writes: number;
  /** Commits from other connections. */
  readonly externalVersion: number;
  readonly eventSequence: number;
  /** Lowest cursor of the thread-scoped projectors (0 while one has none). */
  readonly projectedSequence: number;
}

/**
 * Cached aggregation. Thread-scoped rows (context-window events, activities,
 * turns) are written only by the projection pipeline, in the same transaction
 * as the thread's orchestration event. So a thread whose partial is current
 * stays current until an event with a higher sequence appears on its stream.
 * Global rows (threads, sessions, projects, worktrees) are small and re-read on
 * every miss, which also catches thread meta changes that re-bucket a partial.
 */
interface StatisticsState {
  readonly writes: number;
  readonly externalVersion: number;
  readonly eventSequence: number;
  /** Every thread event up to this sequence is reflected in `partials`. */
  readonly coveredSequence: number;
  readonly partials: ReadonlyMap<string, StatisticsThreadPartial>;
  readonly snapshot: StatisticsSnapshot;
}

const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsThreadRow));
const decodeProjectRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsProjectRow));
const decodeTokenRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsTokenActivityRow));
const decodeToolUseRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsToolUseRow));
const decodeTurnRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsTurnRow));
const decodeWorktreeRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsWorktreeRow));

const decodeError = (operation: string) =>
  toPersistenceDecodeError(`StatisticsQuery.getStatistics:${operation}:decodeRows`);

/** Keep decode errors raised while reading; everything else is a SQL failure. */
const readError = (operation: string) => (cause: SqlError | ProjectionRepositoryError) =>
  isPersistenceError(cause)
    ? (cause as ProjectionRepositoryError)
    : toPersistenceSqlError(`StatisticsQuery.getStatistics:${operation}`)(cause);

const makeStatisticsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRevision = sql<StatisticsRevision>`
    SELECT
      total_changes() AS writes,
      (SELECT data_version FROM pragma_data_version) AS "externalVersion",
      COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS "eventSequence",
      (
        -- A projector without a cursor has applied nothing yet.
        SELECT CASE
          WHEN COUNT(*) < json_array_length(${THREAD_SCOPED_PROJECTORS}) THEN 0
          ELSE MIN(last_applied_sequence)
        END
        FROM projection_state
        WHERE projector IN (SELECT value FROM json_each(${THREAD_SCOPED_PROJECTORS}))
      ) AS "projectedSequence"
  `.pipe(Effect.map((rows) => rows[0]!));

  const listThreadRows = sql`
    SELECT
      t.thread_id AS "threadId",
      t.project_id AS "projectId",
      json_extract(t.model_selection_json, '$.model') AS "model",
      COALESCE(
        json_extract(t.model_selection_json, '$.instanceId'),
        json_extract(t.model_selection_json, '$.provider')
      ) AS "providerInstanceId",
      t.created_at AS "createdAt",
      COALESCE(
        s.provider_name,
        json_extract(t.model_selection_json, '$.instanceId'),
        json_extract(t.model_selection_json, '$.provider')
      ) AS "providerName"
    FROM projection_threads t
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
  `.pipe(
    Effect.flatMap(decodeThreadRows),
    Effect.mapError((cause) =>
      Schema.isSchemaError(cause)
        ? decodeError("listThreads")(cause)
        : toPersistenceSqlError("StatisticsQuery.getStatistics:listThreads:query")(cause),
    ),
  );

  const listProjectRows = sql`
    SELECT
      project_id AS "projectId",
      title,
      deleted_at AS "deletedAt"
    FROM projection_projects
  `;

  const listWorktreeRows = sql`
    SELECT
      worktree_id AS "worktreeId",
      project_id AS "projectId",
      title,
      branch,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      archived_at AS "archivedAt",
      pr_number AS "prNumber",
      pr_title AS "prTitle",
      pr_state AS "prState",
      pr_is_draft AS "prIsDraft",
      pr_terminal_at AS "prTerminalAt",
      origin,
      pull_requests_json AS "pullRequests"
    FROM projection_worktrees
  `;

  const listThreadsWithEventsAfter = (sequence: number) =>
    sql<{ readonly threadId: string }>`
      SELECT DISTINCT stream_id AS "threadId"
      FROM orchestration_events
      WHERE sequence > ${sequence} AND aggregate_kind = 'thread'
    `;

  /**
   * Everything one aggregation needs, read under one transaction. Returns the
   * cached snapshot instead when nothing was written since it was computed.
   * `dirty` is null for a full rebuild.
   */
  const readRows = (state: StatisticsState | undefined) =>
    Effect.gen(function* () {
      const revision = yield* readRevision;
      if (
        state !== undefined &&
        state.writes === revision.writes &&
        state.externalVersion === revision.externalVersion
      ) {
        return { kind: "cached" as const, snapshot: state.snapshot };
      }
      const threadRows = yield* listThreadRows;
      const threadMeta = buildStatisticsThreadMeta(threadRows);
      // On this connection thread-scoped rows change only together with an
      // event on the thread's stream, so new events (plus meta changes) name
      // every thread to re-read. A commit from another connection, or events
      // that disappeared, cannot be attributed: rebuild everything.
      let dirty: Set<string> | null = null;
      if (
        state !== undefined &&
        state.externalVersion === revision.externalVersion &&
        revision.eventSequence >= state.eventSequence
      ) {
        dirty = new Set<string>();
        for (const row of yield* listThreadsWithEventsAfter(state.coveredSequence)) {
          dirty.add(row.threadId);
        }
        for (const [threadId, meta] of threadMeta) {
          if (state.partials.get(threadId)?.metaKey !== statisticsThreadMetaKey(meta)) {
            dirty.add(threadId);
          }
        }
        for (const [threadId, partial] of state.partials) {
          if (!threadMeta.has(threadId) && partial.metaKey !== statisticsThreadMetaKey(undefined)) {
            dirty.add(threadId);
          }
        }
        if (dirty.size > Math.max(INCREMENTAL_THREAD_LIMIT, threadMeta.size / 4)) dirty = null;
      }
      const scope = dirty === null ? null : JSON.stringify([...dirty]);
      const readScoped = (
        read: (scope: string | null) => Effect.Effect<ReadonlyArray<unknown>, SqlError>,
      ) => (dirty !== null && dirty.size === 0 ? Effect.succeed([]) : read(scope));
      return {
        kind: "rows" as const,
        revision,
        threadMeta,
        dirty,
        projectRows: yield* listProjectRows,
        worktreeRows: yield* listWorktreeRows,
        tokenRows: yield* readScoped((scope) => selectStatisticsTokenActivities(sql, scope)),
        toolRows: yield* readScoped((scope) => selectStatisticsToolUses(sql, scope)),
        turnRows: yield* readScoped((scope) => selectStatisticsTurns(sql, scope)),
      };
    });

  type ReadRows = Extract<Effect.Success<ReturnType<typeof readRows>>, { kind: "rows" }>;

  /** Decode and aggregate outside the transaction, yielding between thread chunks. */
  const aggregate = (state: StatisticsState | undefined, read: ReadRows) =>
    Effect.gen(function* () {
      const [projectRows, worktreeRows, tokenRows, toolRows, turnRows] = yield* Effect.all([
        decodeProjectRows(read.projectRows).pipe(Effect.mapError(decodeError("listProjects"))),
        decodeWorktreeRows(read.worktreeRows).pipe(Effect.mapError(decodeError("listWorktrees"))),
        decodeTokenRows(read.tokenRows).pipe(Effect.mapError(decodeError("listTokenActivities"))),
        decodeToolUseRows(read.toolRows).pipe(Effect.mapError(decodeError("listToolUses"))),
        decodeTurnRows(read.turnRows).pipe(Effect.mapError(decodeError("listTurns"))),
      ]);
      const groups = groupStatisticsRowsByThread({
        threadIds: read.dirty ?? read.threadMeta.keys(),
        tokens: tokenRows,
        turns: turnRows,
        tools: toolRows,
      });
      const partials = new Map(read.dirty === null || state === undefined ? [] : state.partials);
      let processed = 0;
      for (const [threadId, rows] of groups) {
        const meta = read.threadMeta.get(threadId);
        const partial = computeStatisticsThreadPartial(meta, rows);
        // A thread without meta or rows contributes nothing and never turns dirty.
        if (meta === undefined && partial.earliest === undefined) partials.delete(threadId);
        else partials.set(threadId, partial);
        if (++processed % AGGREGATION_CHUNK_THREADS === 0) yield* Effect.yieldNow;
      }
      const snapshot = assembleStatisticsSnapshot({
        threadMeta: read.threadMeta,
        partials: partials.values(),
        projectRows,
        worktreeRows,
        generatedAt: new Date().toISOString(),
      });
      const { revision } = read;
      return {
        writes: revision.writes,
        externalVersion: revision.externalVersion,
        eventSequence: revision.eventSequence,
        coveredSequence: Math.min(revision.eventSequence, revision.projectedSequence),
        partials,
        snapshot,
      } satisfies StatisticsState;
    });

  // Keep only one aggregation state and serialize misses, so simultaneous
  // requests share the work without retaining historical analytics copies.
  const cacheLock = yield* Semaphore.make(1);
  let cached: StatisticsState | undefined;
  const getStatistics: StatisticsQueryShape["getStatistics"] = () =>
    Effect.gen(function* () {
      // A caller may inspect uncommitted data. Never publish that result into
      // the shared cache: a rollback does not reset SQLite's total_changes.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        const read = yield* readRows(undefined).pipe(Effect.mapError(readError("query")));
        if (read.kind === "cached") return read.snapshot;
        return (yield* aggregate(undefined, read)).snapshot;
      }
      return yield* cacheLock.withPermit(
        Effect.gen(function* () {
          const state = cached;
          const read = yield* sql
            .withTransaction(readRows(state))
            .pipe(Effect.mapError(readError("transaction")));
          if (read.kind === "cached") return read.snapshot;
          const next = yield* aggregate(state, read);
          cached = next;
          return next.snapshot;
        }),
      );
    });

  return { getStatistics } satisfies StatisticsQueryShape;
});

export const StatisticsQueryLive = Layer.effect(StatisticsQuery, makeStatisticsQuery);
