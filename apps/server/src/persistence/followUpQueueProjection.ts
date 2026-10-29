/**
 * The follow-up queue's SQL (migration 095): the projector's idempotent writes for the
 * `thread.queue-*` events, and the reads of whole queues for the command
 * read model, thread detail and the thread window. Loaded with `import()`
 * (`followUpQueueProjectionLoader.ts`) on the first queue event, or the first read of a thread
 * that has a queue, so a node whose threads never queued anything never loads it.
 *
 * It mirrors `projectFollowUpQueueEvent` (the in-memory projector): replaying an event leaves the
 * same rows. Callers map the SQL and decode errors.
 *
 * It imports no value from a module the server's boot graph loads (only `effect` and the
 * contracts, which are split already), so loading it splits nothing out of the boot chunk.
 *
 * @module followUpQueueProjection
 */
import { FollowUpQueueHold, QueuedFollowUp, ThreadId } from "@ryco/contracts";
import type { MessageId, OrchestrationEvent, ThreadFollowUpQueue } from "@ryco/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

type QueueEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.queue-entry-added"
      | "thread.queue-entry-edited"
      | "thread.queue-reordered"
      | "thread.queue-entries-removed"
      | "thread.queue-entry-failed"
      | "thread.queue-held"
      | "thread.queue-released";
  }
>;

const replaceRow = (sql: SqlClient.SqlClient, threadId: ThreadId, entry: QueuedFollowUp) =>
  sql`
    UPDATE projection_thread_queue_entries
    SET revision = ${entry.revision},
      status = ${entry.status},
      payload_json = ${JSON.stringify(entry)},
      updated_at = ${entry.updatedAt}
    WHERE thread_id = ${threadId} AND message_id = ${entry.messageId}
  `;

/** Inserts before `beforeMessageId` (null or unknown: at the end); a queued entry is replaced in place. */
const addEntry = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  entry: QueuedFollowUp,
  beforeMessageId: MessageId | null,
) =>
  Effect.gen(function* () {
    const existing = yield* sql`
      SELECT 1 FROM projection_thread_queue_entries
      WHERE thread_id = ${threadId} AND message_id = ${entry.messageId}
    `;
    // Replaying an add keeps the entry where it is.
    if (existing.length > 0) return yield* replaceRow(sql, threadId, entry);
    const before =
      beforeMessageId === null
        ? []
        : yield* sql<{ readonly position: number }>`
            SELECT position FROM projection_thread_queue_entries
            WHERE thread_id = ${threadId} AND message_id = ${beforeMessageId}
          `;
    let position: number;
    if (before[0] !== undefined) {
      position = before[0].position;
      yield* sql`
        UPDATE projection_thread_queue_entries SET position = position + 1
        WHERE thread_id = ${threadId} AND position >= ${position}
      `;
    } else {
      const tail = yield* sql<{ readonly next: number }>`
        SELECT COALESCE(MAX(position), -1) + 1 AS "next"
        FROM projection_thread_queue_entries WHERE thread_id = ${threadId}
      `;
      position = tail[0]?.next ?? 0;
    }
    yield* sql`
      INSERT INTO projection_thread_queue_entries (
        thread_id, message_id, position, revision, status, payload_json, created_at, updated_at
      )
      VALUES (
        ${threadId},
        ${entry.messageId},
        ${position},
        ${entry.revision},
        ${entry.status},
        ${JSON.stringify(entry)},
        ${entry.createdAt},
        ${entry.updatedAt}
      )
    `;
  });

/** Orders the thread's entries by `order`; entries it does not name follow, as they were. */
const reorder = (sql: SqlClient.SqlClient, threadId: ThreadId, order: ReadonlyArray<MessageId>) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly messageId: string }>`
      SELECT message_id AS "messageId" FROM projection_thread_queue_entries
      WHERE thread_id = ${threadId}
      ORDER BY position ASC
    `;
    const current = rows.map((row) => row.messageId);
    const named = new Set<string>(order);
    const next = [
      ...order.filter((messageId) => current.includes(messageId)),
      ...current.filter((messageId) => !named.has(messageId)),
    ];
    for (const [position, messageId] of next.entries()) {
      yield* sql`
        UPDATE projection_thread_queue_entries SET position = ${position}
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
    }
  });

const setHold = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  hold: FollowUpQueueHold | null,
  updatedAt: string,
) =>
  hold === null
    ? sql`DELETE FROM projection_thread_queue_holds WHERE thread_id = ${threadId}`
    : sql`
        INSERT INTO projection_thread_queue_holds (thread_id, hold_json, updated_at)
        VALUES (${threadId}, ${JSON.stringify(hold)}, ${updatedAt})
        ON CONFLICT (thread_id)
        DO UPDATE SET hold_json = excluded.hold_json, updated_at = excluded.updated_at
      `;

/** Writes one queue event (or forgets a deleted thread's queue); every write is idempotent. */
export const applyFollowUpQueueEvent = (sql: SqlClient.SqlClient, event: QueueEvent) => {
  switch (event.type) {
    case "thread.queue-entry-added":
      return sql
        .withTransaction(
          addEntry(sql, event.payload.threadId, event.payload.entry, event.payload.beforeMessageId),
        )
        .pipe(Effect.asVoid);
    case "thread.queue-entry-edited":
      return replaceRow(sql, event.payload.threadId, event.payload.entry).pipe(Effect.asVoid);
    case "thread.queue-reordered":
      return sql.withTransaction(reorder(sql, event.payload.threadId, event.payload.order));
    case "thread.queue-entries-removed":
      return event.payload.messageIds.length === 0
        ? Effect.void
        : sql`
            DELETE FROM projection_thread_queue_entries
            WHERE thread_id = ${event.payload.threadId}
              AND ${sql.in("message_id", [...event.payload.messageIds])}
          `.pipe(Effect.asVoid);
    case "thread.queue-entry-failed": {
      const { threadId, messageId, revision, failure, updatedAt } = event.payload;
      return sql`
        UPDATE projection_thread_queue_entries
        SET status = 'failed',
          revision = ${revision},
          updated_at = ${updatedAt},
          payload_json = json_set(
            payload_json,
            '$.status', 'failed',
            '$.failure', json(${JSON.stringify(failure)}),
            '$.revision', ${revision},
            '$.updatedAt', ${updatedAt}
          )
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `.pipe(Effect.asVoid);
    }
    case "thread.queue-held":
      return setHold(sql, event.payload.threadId, event.payload.hold, event.payload.updatedAt).pipe(
        Effect.asVoid,
      );
    case "thread.queue-released":
      return setHold(sql, event.payload.threadId, null, event.payload.updatedAt).pipe(
        Effect.asVoid,
      );
  }
};

const EntryRows = Schema.Array(
  Schema.Struct({ threadId: ThreadId, entry: Schema.fromJsonString(QueuedFollowUp) }),
);
const HoldRows = Schema.Array(
  Schema.Struct({ threadId: ThreadId, hold: Schema.fromJsonString(FollowUpQueueHold) }),
);

/** Every thread's queue (or one thread's), head first; threads without one are absent. */
export const readFollowUpQueues = (sql: SqlClient.SqlClient, threadId?: ThreadId) =>
  Effect.gen(function* () {
    const entryRows = yield* Schema.decodeUnknownEffect(EntryRows)(
      yield* threadId === undefined
        ? sql`
            SELECT thread_id AS "threadId", payload_json AS "entry"
            FROM projection_thread_queue_entries
            ORDER BY thread_id ASC, position ASC
          `
        : sql`
            SELECT thread_id AS "threadId", payload_json AS "entry"
            FROM projection_thread_queue_entries
            WHERE thread_id = ${threadId}
            ORDER BY position ASC
          `,
    );
    const holdRows = yield* Schema.decodeUnknownEffect(HoldRows)(
      yield* threadId === undefined
        ? sql`SELECT thread_id AS "threadId", hold_json AS "hold" FROM projection_thread_queue_holds`
        : sql`
            SELECT thread_id AS "threadId", hold_json AS "hold"
            FROM projection_thread_queue_holds
            WHERE thread_id = ${threadId}
          `,
    );
    const queues = new Map<
      ThreadId,
      { entries: QueuedFollowUp[]; hold: FollowUpQueueHold | null }
    >();
    const queueOf = (id: ThreadId) => {
      let queue = queues.get(id);
      if (queue === undefined) {
        queue = { entries: [], hold: null };
        queues.set(id, queue);
      }
      return queue;
    };
    for (const row of entryRows) queueOf(row.threadId).entries.push(row.entry);
    for (const row of holdRows) queueOf(row.threadId).hold = row.hold;
    return queues as ReadonlyMap<ThreadId, ThreadFollowUpQueue>;
  });
