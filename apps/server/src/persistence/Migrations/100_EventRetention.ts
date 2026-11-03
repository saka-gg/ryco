import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Event-log retention (`EventLogRetention`):
 *
 * - `orchestration_stream_floors`: per stream, the highest sequence below or at which retention
 *   may have removed events that a replay needs. A client that last applied an earlier sequence
 *   of that stream resumes from a snapshot. The row `('log', '')` is the floor of the whole log
 *   (shell resumes, replays across streams). Floors only rise.
 * - `statistics_usage_rollups`: the Statistics contribution (a thread partial) of a deleted
 *   thread incarnation whose events retention removed, written in the same transaction as the
 *   first removal. Unlike `statistics_thread_partials` it is not a cache: its events are gone.
 *
 * No backfill. Idempotent, so it also runs as a repair when a parallel branch recorded this id
 * first.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_stream_floors (
    aggregate_kind TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    floor_sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (aggregate_kind, stream_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS statistics_usage_rollups (
    thread_id TEXT NOT NULL,
    deleted_sequence INTEGER NOT NULL,
    partial_json TEXT NOT NULL,
    rolled_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, deleted_sequence)
  ) WITHOUT ROWID`;
});
