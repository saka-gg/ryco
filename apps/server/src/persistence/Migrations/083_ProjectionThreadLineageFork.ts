import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork provenance on thread lineage: the parent's message and completed turn a
 * fork's inherited history ends at. Nullable, no backfill: only forks set them.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at
 * or below the latest applied one and parallel branches may claim the same id. Returns
 * whether it added a column.
 */
export const ensureProjectionThreadLineageForkColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return false;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(columns.map((column) => column.name));
  let added = false;
  if (!columnNames.has("lineage_source_message_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN lineage_source_message_id TEXT`;
    added = true;
  }
  if (!columnNames.has("lineage_source_turn_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN lineage_source_turn_id TEXT`;
    added = true;
  }
  return added;
});

export default Effect.asVoid(ensureProjectionThreadLineageForkColumns);
