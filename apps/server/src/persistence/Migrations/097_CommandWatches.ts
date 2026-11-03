import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per thread that ever ran a command watch (`thread.command-watch-updated`), like 094's
 * pull request watches:
 *
 * - `watches_json`: the full state (`ThreadCommandWatches`), read once when the server hydrates
 *   its command read model. It holds the command text, never its output (only a hash).
 * - `active_count`: active watches (what thread shells show), behind a partial index.
 *
 * No backfill: no command watch event exists before this table. Idempotent, so it also runs as a
 * repair when a parallel branch recorded this id first.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_command_watches (
    thread_id TEXT PRIMARY KEY,
    watches_json TEXT NOT NULL,
    active_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_command_watches_active
    ON projection_thread_command_watches (thread_id) WHERE active_count > 0`;
});
