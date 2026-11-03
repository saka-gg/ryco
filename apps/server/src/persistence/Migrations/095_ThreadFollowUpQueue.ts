import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The server-owned follow-up queue of each thread (`thread.queue-*` events).
 *
 * - `projection_thread_queue_entries`: one row per queued follow-up. `payload_json` is the full
 *   entry (`QueuedFollowUp`); `position` orders a thread's entries (head first, gaps allowed);
 *   `status` and `revision` mirror the entry, so shells read the head's state without the JSON.
 * - `projection_thread_queue_holds`: one row per held queue (`FollowUpQueueHold`), deleted on
 *   release.
 *
 * No backfill: no queue event exists before these tables. A projection rebuild reproduces them.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id. Returns whether the
 * tables were missing.
 */
export const ensureThreadFollowUpQueueTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('projection_thread_queue_entries', 'projection_thread_queue_holds')
      `;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_queue_entries (
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_queue_entries_position
        ON projection_thread_queue_entries (thread_id, position)`;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_queue_holds (
        thread_id TEXT PRIMARY KEY,
        hold_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
      return existing.length < 2;
    }),
  );
});

export default ensureThreadFollowUpQueueTables.pipe(Effect.asVoid);
