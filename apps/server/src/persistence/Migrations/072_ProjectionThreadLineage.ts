import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Server-owned delegation lineage for threads created on behalf of another
 * thread. New `lineage_*` columns on purpose: the dead 041 `parent_thread_id`
 * column may still hold stale ids from the removed managed-subagent feature.
 *
 * Idempotent, because `runMigrations` also runs it as an unconditional repair:
 * the Effect migrator skips ids at or below the latest recorded one, so a
 * database that recorded a later number first would never run 072.
 */
export const ensureProjectionThreadLineageColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) {
    return;
  }

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("lineage_parent_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN lineage_parent_thread_id TEXT`;
  }
  if (!columnNames.has("lineage_root_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN lineage_root_thread_id TEXT`;
  }
  if (!columnNames.has("lineage_relationship")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN lineage_relationship TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_lineage_parent
    ON projection_threads(lineage_parent_thread_id)
    WHERE lineage_parent_thread_id IS NOT NULL
  `;
});

export default ensureProjectionThreadLineageColumns;
