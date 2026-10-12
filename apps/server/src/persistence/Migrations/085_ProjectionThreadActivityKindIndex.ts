import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A kind-leading index on the largest projection table.
 *
 * The command read model's actionable-activity hydration, the boot checkpoint-revert recovery and
 * the statistics tool-use query all filter by `kind` across every thread. Without an index that
 * leads with `kind`, SQLite walked the whole thread/sequence index and looked up every row to test
 * its kind. The full (not partial) index is deliberate: SQLite's planner ignored a partial
 * `WHERE kind IN (...)` variant for the `IN` query.
 *
 * `idx_projection_thread_activities_thread_sequence` (008) is a strict prefix of
 * `idx_projection_thread_activities_thread_sequence_created_id` (029), so dropping it keeps the
 * number of b-trees written per activity unchanged.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or below
 * the latest applied one and parallel branches may claim the same id.
 */
export const ensureProjectionThreadActivityKindIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_activities'
  `;
  if (tables.length === 0) return false;
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'idx_projection_thread_activities_kind_order',
      'idx_projection_thread_activities_thread_sequence'
    )
  `;
  const names = new Set(indexes.map((index) => index.name));
  if (
    names.has("idx_projection_thread_activities_kind_order") &&
    !names.has("idx_projection_thread_activities_thread_sequence")
  ) {
    return false;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_order
    ON projection_thread_activities(kind, thread_id, sequence, created_at, activity_id)
  `;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence`;
  return true;
});

export default Effect.asVoid(ensureProjectionThreadActivityKindIndex);
