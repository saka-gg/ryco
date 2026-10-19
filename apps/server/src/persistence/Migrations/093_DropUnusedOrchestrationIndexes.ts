import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

const UNUSED_INDEXES = [
  "idx_orch_events_command_id",
  "idx_orch_events_correlation_id",
  "idx_orch_command_receipts_aggregate",
  "idx_orch_command_receipts_sequence",
] as const;

/**
 * Drops four orchestration indexes that no query uses.
 *
 * Every read of `orchestration_events` is keyed by `sequence`, by the `(aggregate_kind,
 * stream_id)` stream indexes, or by the statistics usage index, and `orchestration_command_receipts`
 * is only ever read by its `command_id` primary key. Nothing filters events by `command_id` or
 * `correlation_id`, or receipts by `aggregate_id` or `result_sequence`, yet every event append
 * and receipt upsert still maintained those indexes: a large share of the write-ahead log bytes
 * per event and a sizable slice of the database file.
 *
 * Pages freed here return to the SQLite free list and are reused by later writes; the file is
 * not vacuumed.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id. Returns whether
 * any index was dropped.
 */
export const dropUnusedOrchestrationIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN ('orchestration_events', 'orchestration_command_receipts')
      `;
      const present = new Set(existing.map((row) => row.name));
      const stale = UNUSED_INDEXES.filter((name) => present.has(name));
      for (const name of stale) {
        yield* sql.unsafe(`DROP INDEX IF EXISTS ${name}`);
      }
      return stale.length > 0;
    }),
  );
});

export default dropUnusedOrchestrationIndexes.pipe(Effect.asVoid);
