import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The open-intent ledger for provider-bound side effects (turn start, steer,
 * session stop). One row per tracked request event, keyed by its
 * `orchestration_events.sequence`; inserted in the commit transaction of that
 * event and deleted in the commit transaction of the event that makes its
 * outcome visible. Only the lookup keys are stored: the payload stays in
 * `orchestration_events` and is read back by sequence.
 *
 * Retention contract: no pruning may delete `orchestration_events` rows with
 * `sequence >= MIN(provider_effect_intents.sequence)`. Startup recovery reads
 * the request event of every open row by its sequence.
 *
 * Idempotent, because `runMigrations` also runs it as an unconditional repair:
 * the Effect migrator skips ids at or below the latest recorded one, so a
 * database that recorded a later number first would never run 073.
 */
export const ensureProviderEffectIntentsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS provider_effect_intents (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('turn-start', 'turn-steer', 'session-stop')),
    message_id TEXT,
    handoff_id TEXT,
    recorded_at TEXT NOT NULL,
    dispatched_at TEXT,
    recovery_attempts INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS provider_effect_intents_thread_kind
    ON provider_effect_intents(thread_id, kind, message_id)`;
});

export default ensureProviderEffectIntentsTable;
