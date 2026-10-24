/**
 * The projection reads a server wake's fence takes (`ServerWakeFence`): a thread's pending turn
 * start, how one wake's start ended, and the latest user message the decider fences on. Pure
 * SQL builders, like `userMessageAnchors.ts`; callers map the SQL error.
 */
import { MessageId } from "@ryco/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { hasTurnStartEnded } from "./delegatedRunStatus.ts";
import { latestUserMessageIdQuery } from "./userMessageAnchors.ts";

/** How a wake's turn start stands: bound to a turn, ended without one, still pending, or unknown. */
export type WakeStartState = "bound" | "failed" | "pending" | "absent";

/**
 * Newest unbound turn start of the thread and whether its start already ended
 * without a turn (`startFailed`: it failed, or a Stop cancelled it).
 */
export const readPendingTurnStart = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ messageId: string | null }>`
    SELECT pending_message_id AS "messageId" FROM projection_turns
    WHERE thread_id = ${threadId} AND turn_id IS NULL
    ORDER BY row_id DESC LIMIT 1
  `;
    const row = rows[0];
    if (!row) return null;
    const messageId = row.messageId ?? "";
    return {
      messageId,
      startFailed: messageId.length > 0 && (yield* hasTurnStartEnded(sql, { threadId, messageId })),
    };
  });

/** `failed`: the wake's start ended without a turn (it failed, or a Stop cancelled it). */
export const readWakeStartState = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly messageId: string },
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ turnId: string | null }>`
    SELECT turn_id AS "turnId" FROM projection_turns
    WHERE thread_id = ${input.threadId} AND pending_message_id = ${input.messageId}
    ORDER BY row_id DESC LIMIT 1
  `;
    if (rows[0]?.turnId) return "bound" as const;
    if (yield* hasTurnStartEnded(sql, input)) return "failed" as const;
    return rows[0] ? ("pending" as const) : ("absent" as const);
  });

/** The thread's latest user message id, by the one ordering the decider's fence uses. */
export const readLatestUserMessageId = (sql: SqlClient.SqlClient, threadId: string) =>
  latestUserMessageIdQuery(sql, threadId).pipe(
    Effect.map((rows) => (rows[0] ? MessageId.make(rows[0].messageId) : null)),
  );
