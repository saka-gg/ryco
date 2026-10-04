import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Restart continuation ledger and graceful-shutdown hints.
 *
 * `restart_continuations` holds one row per (thread, source turn) a restart cut off:
 * captured before startup reconciliation, settled exactly once (dispatched, skipped or
 * failed) and pruned 30 days after settling. `restart_shutdown_hints` records, at a
 * graceful shutdown, which threads were running or had live background work.
 *
 * Idempotent, because `runMigrations` also runs it as an unconditional repair: the
 * Effect migrator skips ids at or below the latest recorded one, so a database that
 * recorded 075 first would never run 074.
 */
export const ensureRestartContinuationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS restart_continuations (
    thread_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('in-flight', 'background-only')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'skipped', 'failed')),
    reason TEXT,
    captured_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    settled_at TEXT,
    record_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, source_turn_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS restart_continuations_pending
    ON restart_continuations(last_observed_at DESC, thread_id, source_turn_id)
    WHERE status = 'pending'`;
  yield* sql`CREATE INDEX IF NOT EXISTS restart_continuations_settled
    ON restart_continuations(settled_at) WHERE status <> 'pending'`;
  yield* sql`CREATE TABLE IF NOT EXISTS restart_shutdown_hints (
    thread_id TEXT PRIMARY KEY,
    has_background_work INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL
  )`;
});

export default ensureRestartContinuationTables;
