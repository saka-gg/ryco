/**
 * statisticsRows - the thread-scoped row reads Statistics aggregates: context-window token
 * activities, completed tool calls and turns. Shared by {@link StatisticsQuery} and event-log
 * retention, which freezes a deleted thread's partial from exactly these rows before it removes
 * the thread's events (`statistics_usage_rollups`).
 *
 * @module statisticsRows
 */
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  inheritedActivityRowSql,
  inheritedItemIdSql,
  inheritedTurnRowSql,
} from "../orchestration/forkInheritanceSql.ts";
import { EventLogCompactionUsageReader } from "../persistence/Services/EventLogCompaction.ts";
import {
  buildStatisticsThreadMeta,
  computeStatisticsThreadPartial,
  groupStatisticsRowsByThread,
  StatisticsThreadRow,
  StatisticsTokenActivityRow,
  StatisticsToolUseRow,
  StatisticsTurnRow,
  type StatisticsThreadPartial,
} from "./statisticsAggregation.ts";

/**
 * Thread meta (project, model, provider, creation time). See
 * {@link selectStatisticsTokenActivities} for `scope`.
 */
export function selectStatisticsThreads(sql: SqlClient.SqlClient, scope: string | null) {
  return sql`
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
    ${scope === null ? sql`` : sql`WHERE t.thread_id IN (SELECT value FROM json_each(${scope}))`}
  `;
}

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

export function selectStatisticsTurns(sql: SqlClient.SqlClient, scope: string | null) {
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

/**
 * One thread's partial, computed from the same rows and by the same code as Statistics. Event-log
 * retention stores it (`statistics_usage_rollups`) before it removes the thread's events.
 */
export const readStatisticsThreadPartial = (
  db: SqlClient.SqlClient,
  threadId: string,
): Effect.Effect<StatisticsThreadPartial, SqlError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const scope = JSON.stringify([threadId]);
    const threads = yield* Schema.decodeUnknownEffect(Schema.Array(StatisticsThreadRow))(
      yield* selectStatisticsThreads(db, scope),
    );
    const tokens = yield* Schema.decodeUnknownEffect(Schema.Array(StatisticsTokenActivityRow))(
      yield* selectStatisticsTokenActivities(db, scope),
    );
    const tools = yield* Schema.decodeUnknownEffect(Schema.Array(StatisticsToolUseRow))(
      yield* selectStatisticsToolUses(db, scope),
    );
    const turns = yield* Schema.decodeUnknownEffect(Schema.Array(StatisticsTurnRow))(
      yield* selectStatisticsTurns(db, scope),
    );
    const meta = buildStatisticsThreadMeta(threads).get(threadId);
    const rows = groupStatisticsRowsByThread({ threadIds: [threadId], tokens, turns, tools });
    return computeStatisticsThreadPartial(meta, rows.get(threadId)!);
  });

/** Statistics' reader for event-log retention's usage rollups (`EventLogCompactionUsageReader`). */
export const EventLogCompactionUsageReaderLive = Layer.succeed(EventLogCompactionUsageReader, {
  readThreadUsage: readStatisticsThreadPartial,
});
