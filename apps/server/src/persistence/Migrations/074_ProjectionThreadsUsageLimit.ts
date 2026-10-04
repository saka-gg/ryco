import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable per-thread usage limit (`ThreadUsageLimit` JSON). Idempotent: it also runs as
 * a post-migrator repair, because the migrator skips ids at or below the latest applied
 * one and a database may have recorded a later migration first.
 */
export const ensureProjectionThreadUsageLimitColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return false;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const added = !columns.some((column) => column.name === "usage_limit_json");
  if (added) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_json TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_usage_limited
    ON projection_threads(thread_id) WHERE usage_limit_json IS NOT NULL
  `;
  return added;
});

export default Effect.asVoid(ensureProjectionThreadUsageLimitColumn);
