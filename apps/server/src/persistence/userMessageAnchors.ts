import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

/** A bound thread id, or a code-owned column reference such as sql.literal("threads.thread_id"). */
type ThreadRef = string | Statement.Fragment;

/** First user message: oldest created_at, ties by message_id. Proves the thread has started. */
export const firstUserMessageIdQuery = (sql: SqlClient.SqlClient, thread: ThreadRef) =>
  sql<{ readonly messageId: string }>`
    SELECT first_user.message_id AS "messageId"
    FROM projection_thread_messages first_user
    WHERE first_user.thread_id = ${thread} AND first_user.role = 'user'
    ORDER BY first_user.created_at ASC, first_user.message_id ASC
    LIMIT 1
  `;

/**
 * The ONE definition of a thread's latest user message: newest created_at, ties broken by
 * insertion order (rowid). The delegated-return fence compares the engine's hydrated anchor
 * (ProjectionSnapshotQuery.getCommandReadModel) with CompletionReturnDelivery's read
 * (CompletionReturnRepository.latestUserMessageId). Any divergence rejects valid returns or
 * weakens the fence. Never inline this ordering elsewhere. The in-memory twin used by the
 * decider and the projector's message cap is `latestUserMessage`
 * (orchestration/userMessageOrder.ts), not `findLast(user)`.
 */
export const latestUserMessageIdQuery = (sql: SqlClient.SqlClient, thread: ThreadRef) =>
  sql<{ readonly messageId: string }>`
    SELECT latest_user.message_id AS "messageId"
    FROM projection_thread_messages latest_user
    WHERE latest_user.thread_id = ${thread} AND latest_user.role = 'user'
    ORDER BY latest_user.created_at DESC, latest_user.rowid DESC
    LIMIT 1
  `;
