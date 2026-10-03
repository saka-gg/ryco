import { Clock, Context, DateTime, Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  DailyRecapReadError,
  DailyRecapThread,
  type DailyRecapRequest,
  type DailyRecapSnapshot,
} from "@ryco/contracts";

import { makeUsageDayFormatter } from "../usage/usageAggregation.ts";

export interface DailyRecapQueryShape {
  readonly getDailyRecap: (
    input: DailyRecapRequest,
  ) => Effect.Effect<DailyRecapSnapshot, DailyRecapReadError>;
}

export class DailyRecapQuery extends Context.Service<DailyRecapQuery, DailyRecapQueryShape>()(
  "ryco/statistics/DailyRecapQuery",
) {}

const DAY_MS = 86_400_000;

/** Resolve both local midnights separately: a calendar day need not last 24 hours. */
export const dailyRecapWindow = (input: Pick<DailyRecapRequest, "date" | "timeZone">) =>
  Effect.gen(function* () {
    const utcMidnight = Date.parse(`${input.date}T00:00:00.000Z`);
    if (
      !Number.isFinite(utcMidnight) ||
      new Date(utcMidnight).toISOString().slice(0, 10) !== input.date
    ) {
      return yield* new DailyRecapReadError({
        reason: "invalid-date",
        detail: "Choose a valid calendar date.",
      });
    }
    const zone = DateTime.zoneMakeNamed(input.timeZone);
    if (Option.isNone(zone)) {
      return yield* new DailyRecapReadError({
        reason: "invalid-time-zone",
        detail: "Choose a recognized IANA time zone.",
      });
    }
    const start = DateTime.makeZonedUnsafe(utcMidnight, {
      timeZone: zone.value,
      adjustForTimeZone: true,
    });
    const end = DateTime.makeZonedUnsafe(utcMidnight + DAY_MS, {
      timeZone: zone.value,
      adjustForTimeZone: true,
    });
    // Some historical time-zone changes skipped a whole calendar day.
    if (
      makeUsageDayFormatter(input.timeZone)(DateTime.toEpochMillis(start)) !== input.date ||
      DateTime.toEpochMillis(end) <= DateTime.toEpochMillis(start)
    ) {
      return yield* new DailyRecapReadError({
        reason: "invalid-date",
        detail: "This calendar date does not exist in the selected time zone.",
      });
    }
    return { from: DateTime.formatIso(start), to: DateTime.formatIso(end) };
  });

const Window = Schema.Struct({ from: Schema.String, to: Schema.String });
const OutcomeRequest = Schema.Struct({
  ...Window.fields,
  state: Schema.Literals(["completed", "error"]),
  limit: Schema.Number,
});
const ThreadRow = Schema.Struct({ ...DailyRecapThread.fields, totalThreads: Schema.Number });
const AttentionRow = Schema.Struct({
  ...ThreadRow.fields,
  pendingApprovals: Schema.Number,
  pendingUserInputs: Schema.Number,
  hasProposedPlan: Schema.Number,
  sessionError: Schema.Number,
});

const section = <A extends { readonly totalThreads: number }>(rows: ReadonlyArray<A>) => {
  const totalThreads = rows[0]?.totalThreads ?? 0;
  return {
    totalThreads,
    threads: rows.map((row) => Struct.omit(row, ["totalThreads"])),
    truncated: totalThreads > rows.length,
  };
};

export const DailyRecapQueryLive = Layer.effect(
  DailyRecapQuery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Non-streaming commentary may set a turn's projection to completed while
    // its provider is still running. Match shell completion-recency semantics.
    const terminalOutcome = sql`(turns.state <> 'completed' OR NOT EXISTS (
      SELECT 1 FROM projection_thread_sessions sessions
      WHERE sessions.thread_id = turns.thread_id AND sessions.active_turn_id = turns.turn_id
    ))`;
    const counts = SqlSchema.findAll({
      Request: Window,
      Result: Schema.Struct({
        completedTurns: Schema.Number,
        failedTurns: Schema.Number,
        interruptedTurns: Schema.Number,
      }),
      execute: ({ from, to }) => sql`
        SELECT
          COALESCE(SUM(turns.state = 'completed'), 0) AS "completedTurns",
          COALESCE(SUM(turns.state = 'error'), 0) AS "failedTurns",
          COALESCE(SUM(turns.state = 'interrupted'), 0) AS "interruptedTurns"
        FROM projection_turns turns
        JOIN projection_threads threads ON threads.thread_id = turns.thread_id
        JOIN projection_projects projects ON projects.project_id = threads.project_id
        WHERE turns.completed_at >= ${from} AND turns.completed_at < ${to}
          AND threads.deleted_at IS NULL AND projects.deleted_at IS NULL
          AND ${terminalOutcome}
      `,
    });
    const outcomes = SqlSchema.findAll({
      Request: OutcomeRequest,
      Result: ThreadRow,
      execute: ({ from, to, state, limit }) => sql`
        SELECT threads.thread_id AS "threadId", threads.title AS "threadTitle",
          projects.project_id AS "projectId", projects.title AS "projectTitle",
          MAX(turns.completed_at) AS "lastActivityAt", COUNT(*) OVER () AS "totalThreads"
        FROM projection_turns turns
        JOIN projection_threads threads ON threads.thread_id = turns.thread_id
        JOIN projection_projects projects ON projects.project_id = threads.project_id
        WHERE turns.completed_at >= ${from} AND turns.completed_at < ${to}
          AND turns.state = ${state}
          AND threads.deleted_at IS NULL AND projects.deleted_at IS NULL
          AND ${terminalOutcome}
        GROUP BY threads.thread_id
        ORDER BY "lastActivityAt" DESC, threads.thread_id ASC
        LIMIT ${limit}
      `,
    });
    const attention = SqlSchema.findAll({
      Request: Schema.Number,
      Result: AttentionRow,
      execute: (limit) => sql`
        WITH candidates AS (
          SELECT thread_id FROM projection_threads
          WHERE deleted_at IS NULL AND archived_at IS NULL
            AND (pending_approval_count > 0 OR pending_user_input_count > 0
              OR has_actionable_proposed_plan = 1)
          UNION
          SELECT thread_id FROM projection_thread_sessions WHERE status = 'error'
        )
        SELECT threads.thread_id AS "threadId", threads.title AS "threadTitle",
          projects.project_id AS "projectId", projects.title AS "projectTitle",
          MAX(threads.updated_at, COALESCE(sessions.updated_at, threads.updated_at)) AS "lastActivityAt",
          threads.pending_approval_count AS "pendingApprovals",
          threads.pending_user_input_count AS "pendingUserInputs",
          threads.has_actionable_proposed_plan AS "hasProposedPlan",
          COALESCE(sessions.status = 'error', 0) AS "sessionError",
          COUNT(*) OVER () AS "totalThreads"
        FROM candidates
        JOIN projection_threads threads ON threads.thread_id = candidates.thread_id
        JOIN projection_projects projects ON projects.project_id = threads.project_id
        LEFT JOIN projection_thread_sessions sessions ON sessions.thread_id = threads.thread_id
        WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
        ORDER BY "lastActivityAt" DESC, threads.thread_id ASC
        LIMIT ${limit}
      `,
    });

    return DailyRecapQuery.of({
      getDailyRecap: (input) =>
        Effect.gen(function* () {
          const window = yield* dailyRecapWindow(input);
          const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20)));
          const result = yield* Effect.gen(function* () {
            const countRows = yield* counts(window);
            const completed = yield* outcomes({ ...window, state: "completed", limit });
            const failed = yield* outcomes({ ...window, state: "error", limit });
            const attentionRows = yield* attention(limit);
            return {
              counts: countRows[0] ?? {
                completedTurns: 0,
                failedTurns: 0,
                interruptedTurns: 0,
              },
              completed: section(completed),
              failed: section(failed),
              needsAttention: section(
                attentionRows.map((row) => ({
                  threadId: row.threadId,
                  threadTitle: row.threadTitle,
                  projectId: row.projectId,
                  projectTitle: row.projectTitle,
                  lastActivityAt: row.lastActivityAt,
                  totalThreads: row.totalThreads,
                  pendingApprovals: row.pendingApprovals,
                  pendingUserInputs: row.pendingUserInputs,
                  hasProposedPlan: row.hasProposedPlan === 1,
                  sessionError: row.sessionError === 1,
                })),
              ),
            };
          }).pipe(
            sql.withTransaction,
            Effect.mapError(
              () =>
                new DailyRecapReadError({
                  reason: "query-failed",
                  detail: "Unable to read the daily work recap.",
                }),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          return {
            date: input.date,
            timeZone: input.timeZone,
            generatedAt: new Date(now).toISOString(),
            ...window,
            ...result,
          };
        }),
    });
  }),
);
