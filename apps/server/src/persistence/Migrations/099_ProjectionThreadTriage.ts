import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Thread triage: `hidden_at` (the Hidden shelf) and `settle_when_idle_at` (a settle asked for
 * while the thread was working, which the node carries out once that work ends). Nullable, no
 * backfill.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or below
 * the latest applied one and parallel branches may claim the same id. Returns whether it added a
 * column.
 */
export const ensureProjectionThreadTriageColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return false;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(columns.map((column) => column.name));
  let added = false;
  if (!columnNames.has("hidden_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN hidden_at TEXT`;
    added = true;
  }
  if (!columnNames.has("settle_when_idle_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN settle_when_idle_at TEXT`;
    added = true;
  }
  return added;
});

export default Effect.asVoid(ensureProjectionThreadTriageColumns);
