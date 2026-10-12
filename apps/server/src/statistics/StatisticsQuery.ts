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
 * The node:sqlite client is synchronous and the writer owns one connection, so
 * rows are read in one transaction on the read-only worker connection
 * (SqliteReadClient) when the runtime has one, then decoded and aggregated on
 * the main thread in chunks. Reads are kept minimal: per-thread partial
 * aggregates are cached in memory and persisted (statistics_thread_partials),
 * and only threads with new orchestration events are re-read (see
 * {@link StatisticsState}), also on the first open after a restart. The RPC
 * serves the previous snapshot when a refresh takes longer than a short wait
 * (stale-while-revalidate).
 *
 * A fork's inherited turns and activities are display copies of its source's history: the work
 * is already counted once, on the source, so every reader here leaves them out.
 *
 * @module StatisticsQuery
 */
import { type StatisticsSnapshot } from "@ryco/contracts";
import { Context, Duration, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect";
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
import { SqliteReadClient } from "../persistence/SqliteReadClient.ts";
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
  readonly getStatistics: (
    options?: GetStatisticsOptions,
  ) => Effect.Effect<StatisticsSnapshot, ProjectionRepositoryError>;
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

/**
 * Turns with their checkpoint file totals. SQLite sums the files (on the read worker when there
 * is one), so the main thread never parses checkpoint_files_json. Malformed or non-array JSON
 * counts as no files, and only numeric additions/deletions count, as before in JS.
 */
const checkpointFilesTotal = (sql: SqlClient.SqlClient, field: "additions" | "deletions") => sql`
  CASE WHEN json_valid(turns.checkpoint_files_json) THEN
    CASE WHEN json_type(turns.checkpoint_files_json) = 'array' THEN (
      SELECT COALESCE(SUM(
        CASE WHEN json_type(files.value, ${`$.${field}`}) IN ('integer', 'real')
          THEN json_extract(files.value, ${`$.${field}`}) ELSE 0 END
      ), 0)
      FROM json_each(turns.checkpoint_files_json) AS files
    ) ELSE 0 END
  ELSE 0 END
`;

function selectStatisticsTurns(sql: SqlClient.SqlClient, scope: string | null) {
  return sql`
    SELECT
      thread_id AS "threadId",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      checkpoint_turn_count AS "checkpointTurnCount",
      CASE WHEN json_valid(turns.checkpoint_files_json) THEN
        CASE WHEN json_type(turns.checkpoint_files_json) = 'array'
          THEN json_array_length(turns.checkpoint_files_json) ELSE 0 END
      ELSE 0 END AS "filesChanged",
      ${checkpointFilesTotal(sql, "additions")} AS additions,
      ${checkpointFilesTotal(sql, "deletions")} AS deletions
    FROM projection_turns turns
    WHERE NOT ${inheritedTurnRowSql(sql, "turns")}
      ${scope === null ? sql`` : sql`AND thread_id IN (SELECT value FROM json_each(${scope}))`}
  `;
}

interface StatisticsRevision {
  /** Writes on the main connection. Never reset by a rollback. */
  readonly writes: number;
  /** Commits from other processes, as seen by the main connection. */
  readonly externalVersion: number;
  readonly eventSequence: number;
  /** Lowest cursor of the thread-scoped projectors (0 while one has none). */
  readonly projectedSequence: number;
  /** The latest applied migration; persisted partials are only reused under the same schema. */
  readonly schemaVersion: string;
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
  /** Null for partials restored from disk: they never match a live revision. */
  readonly writes: number | null;
  readonly externalVersion: number | null;
  readonly eventSequence: number;
  /** Every thread event up to this sequence is reflected in `partials`. */
  readonly coveredSequence: number;
  readonly partials: ReadonlyMap<string, StatisticsThreadPartial>;
  /** Undefined for partials restored from disk. */
  readonly snapshot: StatisticsSnapshot | undefined;
}

/**
 * Bump whenever {@link computeStatisticsThreadPartial} would produce different
 * partials for the same rows: persisted partials of another version are dropped.
 */
export const STATISTICS_PARTIAL_FORMAT_VERSION = 1;

/** How long the RPC waits for a refresh before it answers with the previous snapshot. */
export const STATISTICS_STALE_WHILE_REVALIDATE_WAIT_MS = 250;

export interface GetStatisticsOptions {
  /**
   * Stale-while-revalidate: when a previous snapshot exists and a refresh takes
   * longer than this, answer with the previous snapshot (its `generatedAt` says
   * how old it is) and let the refresh finish in the background for the next
   * request. Omit for a fresh answer.
   */
  readonly maxWaitMs?: number;
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

export const makeStatisticsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Row reads run on the read-only worker connection when the runtime has one, so neither the
  // event loop nor the writer's connection is held while SQLite reads the history.
  const reader = Option.getOrElse(yield* Effect.serviceOption(SqliteReadClient), () => sql);
  const scope = yield* Effect.scope;

  // Cheap (a few index probes) and on the main connection: total_changes() and data_version
  // are per-connection, and only the writer's values say whether anything changed.
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
      ) AS "projectedSequence",
      COALESCE((SELECT CAST(MAX(migration_id) AS TEXT) FROM effect_sql_migrations), '0')
        AS "schemaVersion"
  `.pipe(Effect.map((rows) => rows[0]!));

  const listThreadRows = (db: SqlClient.SqlClient) =>
    db`
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

  const listProjectRows = (db: SqlClient.SqlClient) => db`
    SELECT
      project_id AS "projectId",
      title,
      deleted_at AS "deletedAt"
    FROM projection_projects
  `;

  const listWorktreeRows = (db: SqlClient.SqlClient) => db`
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

  const listThreadsWithEventsAfter = (db: SqlClient.SqlClient, sequence: number) =>
    db<{ readonly threadId: string }>`
      SELECT DISTINCT stream_id AS "threadId"
      FROM orchestration_events
      WHERE sequence > ${sequence} AND aggregate_kind = 'thread'
    `;

  /**
   * Everything one aggregation needs, read under one transaction of `db`.
   * `dirty` is null for a full rebuild.
   */
  const readRows = (
    db: SqlClient.SqlClient,
    state: StatisticsState | undefined,
    revision: StatisticsRevision,
  ) =>
    Effect.gen(function* () {
      const threadRows = yield* listThreadRows(db);
      const threadMeta = buildStatisticsThreadMeta(threadRows);
      // Thread-scoped rows change only together with an event on the thread's
      // stream, so new events (plus meta changes) name every thread to re-read.
      // A commit from another process seen by a live cache, events that
      // disappeared, or projections that were reset cannot be attributed:
      // rebuild everything. Partials restored from disk carry no connection
      // revision; they were validated against the schema and sequences on load.
      let dirty: Set<string> | null = null;
      if (
        state !== undefined &&
        (state.externalVersion === null || state.externalVersion === revision.externalVersion) &&
        revision.eventSequence >= state.eventSequence &&
        revision.projectedSequence >= state.coveredSequence
      ) {
        dirty = new Set<string>();
        for (const row of yield* listThreadsWithEventsAfter(db, state.coveredSequence)) {
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
        revision,
        threadMeta,
        dirty,
        projectRows: yield* listProjectRows(db),
        worktreeRows: yield* listWorktreeRows(db),
        tokenRows: yield* readScoped((scope) => selectStatisticsTokenActivities(db, scope)),
        toolRows: yield* readScoped((scope) => selectStatisticsToolUses(db, scope)),
        turnRows: yield* readScoped((scope) => selectStatisticsTurns(db, scope)),
      };
    });

  type ReadRows = Effect.Success<ReturnType<typeof readRows>>;

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
      const changed = new Set<string>();
      let processed = 0;
      for (const [threadId, rows] of groups) {
        const meta = read.threadMeta.get(threadId);
        const partial = computeStatisticsThreadPartial(meta, rows);
        // A thread without meta or rows contributes nothing and never turns dirty.
        if (meta === undefined && partial.earliest === undefined) partials.delete(threadId);
        else partials.set(threadId, partial);
        changed.add(threadId);
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
        state: {
          writes: revision.writes,
          externalVersion: revision.externalVersion,
          eventSequence: revision.eventSequence,
          coveredSequence: Math.min(revision.eventSequence, revision.projectedSequence),
          partials,
          snapshot,
        } satisfies StatisticsState,
        /** Thread ids whose partial was recomputed; null when every partial was. */
        changed: read.dirty === null ? null : changed,
      };
    });

  /**
   * Restores the partials the previous process persisted, when they were
   * written under this schema and aggregation format and the history has not
   * moved backwards since. Anything else, including unreadable rows, means a
   * full recompute; the stored rows are a cache, never a source of truth.
   */
  const loadPersistedState = (revision: StatisticsRevision) =>
    Effect.gen(function* () {
      const [header] = yield* reader<{
        readonly formatVersion: number;
        readonly schemaVersion: string;
        readonly coveredSequence: number;
        readonly eventSequence: number;
      }>`
        SELECT
          format_version AS "formatVersion",
          schema_version AS "schemaVersion",
          covered_sequence AS "coveredSequence",
          event_sequence AS "eventSequence"
        FROM statistics_partials_state WHERE id = 1
      `;
      if (
        header === undefined ||
        header.formatVersion !== STATISTICS_PARTIAL_FORMAT_VERSION ||
        header.schemaVersion !== revision.schemaVersion ||
        header.eventSequence > revision.eventSequence ||
        header.coveredSequence > revision.projectedSequence
      ) {
        return undefined;
      }
      const rows = yield* reader<{ readonly threadId: string; readonly partialJson: string }>`
        SELECT thread_id AS "threadId", partial_json AS "partialJson"
        FROM statistics_thread_partials
      `;
      const partials = new Map<string, StatisticsThreadPartial>();
      for (const row of rows) {
        partials.set(row.threadId, JSON.parse(row.partialJson) as StatisticsThreadPartial);
      }
      return {
        writes: null,
        externalVersion: null,
        eventSequence: header.eventSequence,
        coveredSequence: header.coveredSequence,
        partials,
        snapshot: undefined,
      } satisfies StatisticsState;
    }).pipe(
      // Older schema (no table yet) or a corrupt row: recompute instead.
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  /**
   * Writes the recomputed partials, so the next process starts incremental.
   * Returns how many rows this wrote on the main connection, so the cached
   * revision can account for its own writes.
   */
  const persistState = (state: StatisticsState, changed: ReadonlySet<string> | null) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [before] = yield* sql<{
            readonly writes: number;
          }>`SELECT total_changes() AS writes`;
          if (changed === null) yield* sql`DELETE FROM statistics_thread_partials`;
          const threadIds = changed ?? state.partials.keys();
          for (const threadId of threadIds) {
            const partial = state.partials.get(threadId);
            if (partial === undefined) {
              if (changed !== null) {
                yield* sql`DELETE FROM statistics_thread_partials WHERE thread_id = ${threadId}`;
              }
              continue;
            }
            yield* sql`
              INSERT INTO statistics_thread_partials (thread_id, partial_json)
              VALUES (${threadId}, ${JSON.stringify(partial)})
              ON CONFLICT (thread_id) DO UPDATE SET partial_json = excluded.partial_json
            `;
          }
          const [schema] = yield* sql<{ readonly version: string }>`
            SELECT COALESCE(CAST(MAX(migration_id) AS TEXT), '0') AS version FROM effect_sql_migrations
          `;
          yield* sql`
            INSERT INTO statistics_partials_state (
              id, format_version, schema_version, covered_sequence, event_sequence, updated_at
            ) VALUES (
              1, ${STATISTICS_PARTIAL_FORMAT_VERSION}, ${schema?.version ?? "0"},
              ${state.coveredSequence}, ${state.eventSequence}, ${new Date().toISOString()}
            )
            ON CONFLICT (id) DO UPDATE SET
              format_version = excluded.format_version,
              schema_version = excluded.schema_version,
              covered_sequence = excluded.covered_sequence,
              event_sequence = excluded.event_sequence,
              updated_at = excluded.updated_at
          `;
          const [after] = yield* sql<{ readonly writes: number }>`SELECT total_changes() AS writes`;
          return (after?.writes ?? 0) - (before?.writes ?? 0);
        }),
      )
      .pipe(
        // A cache write must never fail a read; the next process recomputes instead.
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist statistics partials", { cause }).pipe(Effect.as(0)),
        ),
      );

  // Keep only one aggregation state and serialize misses, so simultaneous
  // requests share the work without retaining historical analytics copies.
  const cacheLock = yield* Semaphore.make(1);
  let cached: StatisticsState | undefined;
  let restored = false;

  const refresh: Effect.Effect<StatisticsSnapshot, ProjectionRepositoryError> =
    cacheLock.withPermit(
      Effect.gen(function* () {
        const revision = yield* readRevision.pipe(Effect.mapError(readError("revision")));
        let state = cached;
        if (
          state?.snapshot !== undefined &&
          state.writes === revision.writes &&
          state.externalVersion === revision.externalVersion
        ) {
          return state.snapshot;
        }
        if (state === undefined && !restored) {
          restored = true;
          state = yield* loadPersistedState(revision);
        }
        const read = yield* reader
          .withTransaction(readRows(reader, state, revision))
          .pipe(Effect.mapError(readError("transaction")));
        const next = yield* aggregate(state, read);
        const ownWrites =
          next.changed === null || next.changed.size > 0
            ? yield* persistState(next.state, next.changed)
            : 0;
        cached = { ...next.state, writes: revision.writes + ownWrites };
        return next.state.snapshot!;
      }),
    );

  // One background refresh at a time for stale-while-revalidate callers.
  let backgroundRefresh: Fiber.Fiber<StatisticsSnapshot, ProjectionRepositoryError> | undefined;
  const sharedRefresh = Effect.suspend(() => {
    if (backgroundRefresh !== undefined) return Effect.succeed(backgroundRefresh);
    return Effect.forkIn(
      refresh.pipe(Effect.ensuring(Effect.sync(() => (backgroundRefresh = undefined)))),
      scope,
    ).pipe(Effect.tap((fiber) => Effect.sync(() => (backgroundRefresh = fiber))));
  });

  const getStatistics: StatisticsQueryShape["getStatistics"] = (options) =>
    Effect.gen(function* () {
      // A caller may inspect uncommitted data. Never publish that result into
      // the shared cache: a rollback does not reset SQLite's total_changes.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        const revision = yield* readRevision.pipe(Effect.mapError(readError("revision")));
        const read = yield* readRows(sql, undefined, revision).pipe(
          Effect.mapError(readError("query")),
        );
        return (yield* aggregate(undefined, read)).state.snapshot!;
      }
      const stale = cached?.snapshot;
      if (options?.maxWaitMs === undefined || stale === undefined) return yield* refresh;
      const fiber = yield* sharedRefresh;
      const fresh = yield* Fiber.join(fiber).pipe(
        Effect.timeoutOption(Duration.millis(options.maxWaitMs)),
      );
      return Option.getOrElse(fresh, () => stale);
    });

  return { getStatistics } satisfies StatisticsQueryShape;
});

export const StatisticsQueryLive = Layer.effect(StatisticsQuery, makeStatisticsQuery);
