import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Chat fork ledger: one row per client fork key, written at acceptance before any side effect.
 *
 * The row pins the request digest (key reuse with other inputs is refused), the derived fork
 * thread id, the accepted plan, and every resource the run created, so a restart resumes from
 * `phase` without repeating a native fork or creating a second checkout. JSON columns are typed
 * by `threadFork/forkLedger.ts`.
 *
 * Idempotent, because `runMigrations` also runs it as a repair: the Effect migrator skips ids at
 * or below the latest recorded one, and parallel branches claim the same next id.
 */
export const ensureThreadForksTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_forks (
    fork_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    fork_thread_id TEXT NOT NULL UNIQUE,
    source_thread_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    destination_kind TEXT NOT NULL
      CHECK (destination_kind IN ('current-checkout', 'new-worktree', 'new-chat')),
    phase TEXT NOT NULL CHECK (phase IN (
      'accepted',
      'checkout-preparing',
      'checkout-ready',
      'provider-forking',
      'provider-ready',
      'published',
      'completed',
      'failed'
    )),
    plan_json TEXT NOT NULL,
    checkout_json TEXT,
    provider_json TEXT,
    attachments_json TEXT,
    result_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_forks_unfinished
    ON thread_forks(created_at, fork_key)
    WHERE phase NOT IN ('completed', 'failed')`;
});

export default ensureThreadForksTable;
