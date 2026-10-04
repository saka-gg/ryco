import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * State of one delegated run, keyed by the exact delegated user message (never the latest
 * turn of a reused chat). Shared by local Tasks (`LocalTaskService.present`) and Agent
 * Control delegation returns, so start failures and Stop-cancelled starts are recognised in
 * one place.
 */
export type DelegatedRunState =
  | "starting"
  | "running"
  | "needs-you"
  | "completed"
  | "failed"
  | "interrupted"
  | "rejected"
  | "unavailable";

/**
 * A `provider.turn.start.failed` activity for the message. Same expression as the
 * `local_task_start_failures` index (migration 070), so the lookup stays indexed.
 */
export const hasTurnStartFailure = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly messageId: string },
) =>
  sql`SELECT 1 FROM projection_thread_activities
    WHERE thread_id = ${input.threadId} AND kind = 'provider.turn.start.failed'
      AND json_valid(payload_json) AND json_extract(payload_json, '$.messageId') = ${input.messageId}
    LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

/**
 * A `provider.turn.start.cancelled` activity for the message: a Stop ended the start
 * before any turn. It is not covered by the migration-070 partial index (the lookup
 * scans the thread's activities), so check it only for a start that never bound.
 */
export const hasTurnStartCancelled = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly messageId: string },
) =>
  sql`SELECT 1 FROM projection_thread_activities
    WHERE thread_id = ${input.threadId} AND kind = 'provider.turn.start.cancelled'
      AND json_valid(payload_json) AND json_extract(payload_json, '$.messageId') = ${input.messageId}
    LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

/**
 * The start failed or a Stop cancelled it: it ended without a turn and never binds
 * one. Callers ask only for starts that have not bound a turn.
 */
export const hasTurnStartEnded = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly messageId: string },
) =>
  hasTurnStartFailure(sql, input).pipe(
    Effect.flatMap((failed) => (failed ? Effect.succeed(true) : hasTurnStartCancelled(sql, input))),
  );

export const readDelegatedRunState = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly commandId?: string;
    readonly dispatched?: boolean;
  },
): Effect.Effect<DelegatedRunState, SqlError> =>
  Effect.gen(function* () {
    if (input.commandId !== undefined) {
      const receipts = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_command_receipts WHERE command_id = ${input.commandId}`;
      if (receipts[0]?.status === "rejected") return "rejected" as const;
    }
    const threads = yield* sql<{
      deleted_at: string | null;
      pending_approval_count: number;
      pending_user_input_count: number;
    }>`
      SELECT deleted_at, pending_approval_count, pending_user_input_count FROM projection_threads WHERE thread_id = ${input.threadId}`;
    const thread = threads[0];
    if (!thread) return input.dispatched ? ("unavailable" as const) : ("starting" as const);
    if (thread.deleted_at !== null) return "unavailable" as const;
    if (yield* hasTurnStartFailure(sql, input)) return "failed" as const;
    const turns = yield* sql<{
      state: string;
      turn_id: string | null;
      active_turn_id: string | null;
    }>`
      SELECT turns.state, turns.turn_id, sessions.active_turn_id
      FROM projection_turns turns LEFT JOIN projection_thread_sessions sessions ON sessions.thread_id = turns.thread_id
      WHERE turns.thread_id = ${input.threadId} AND turns.pending_message_id = ${input.messageId}
      ORDER BY turns.row_id DESC LIMIT 1`;
    const turn = turns[0];
    if (!turn) return "starting" as const;
    if (turn.state === "error") return "failed" as const;
    if (turn.state === "interrupted") return "interrupted" as const;
    const active = turn.turn_id !== null && turn.active_turn_id === turn.turn_id;
    if (active && (thread.pending_approval_count > 0 || thread.pending_user_input_count > 0))
      return "needs-you" as const;
    if (active || turn.state === "running") return "running" as const;
    if (turn.state === "completed") return "completed" as const;
    if (turn.state !== "pending") return "failed" as const;
    // A start the user's Stop cancelled keeps its pending row, but will never run.
    return (yield* hasTurnStartCancelled(sql, input))
      ? ("interrupted" as const)
      : ("starting" as const);
  });
