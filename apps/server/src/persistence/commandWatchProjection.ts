/**
 * The command watches' SQL (migration 097): the projector's idempotent write for
 * `thread.command-watch-updated` and the read of every thread's watches for the command read
 * model. Loaded with `import()` (`commandWatchProjectionLoader.ts`) on the first command watch
 * event, or the first hydration that finds a row, so a node whose agents never watched a
 * command never loads it. Callers map the SQL and decode errors.
 *
 * It imports no value from a module the server's boot graph loads (only `effect`), so loading it
 * splits nothing out of the boot chunks.
 *
 * @module commandWatchProjection
 */
import type {
  OrchestrationEvent,
  ThreadCommandWatches,
  ThreadCommandWatchUpdatedPayload,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The projector's write: a watch event replaces the thread's row (the payload carries the whole
 * list, so replaying is idempotent); a permanent delete drops it.
 */
export const applyCommandWatchEvent = (
  sql: SqlClient.SqlClient,
  event: Extract<OrchestrationEvent, { type: "thread.command-watch-updated" | "thread.deleted" }>,
) =>
  event.type === "thread.deleted"
    ? sql`DELETE FROM projection_thread_command_watches WHERE thread_id = ${event.payload.threadId}`
    : writeCommandWatches(sql, event.payload);

const writeCommandWatches = (sql: SqlClient.SqlClient, payload: ThreadCommandWatchUpdatedPayload) =>
  sql`
    INSERT INTO projection_thread_command_watches (
      thread_id, watches_json, active_count, updated_at
    )
    VALUES (
      ${payload.threadId},
      ${JSON.stringify(payload.watches)},
      ${payload.watches.active.length},
      ${payload.updatedAt}
    )
    ON CONFLICT (thread_id) DO UPDATE SET
      watches_json = excluded.watches_json,
      active_count = excluded.active_count,
      updated_at = excluded.updated_at
  `;

/**
 * Every thread's full watch state (active and ended), for the command read model. The caller
 * hands over the contract schema, so this chunk imports no contract module of its own.
 */
export const readCommandWatches = (
  sql: SqlClient.SqlClient,
  watchesSchema: Schema.Codec<ThreadCommandWatches, typeof ThreadCommandWatches.Encoded>,
) =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({ threadId: Schema.String, watches: Schema.fromJsonString(watchesSchema) }),
      ),
    )(
      yield* sql`
        SELECT thread_id AS "threadId", watches_json AS "watches"
        FROM projection_thread_command_watches
      `,
    );
    return new Map(rows.map((row) => [row.threadId as ThreadId, row.watches] as const));
  });
