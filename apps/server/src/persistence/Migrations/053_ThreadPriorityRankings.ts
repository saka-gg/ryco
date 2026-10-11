import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_priority_batches (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      batch_id TEXT NOT NULL UNIQUE,
      input_fingerprint TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      model_fingerprint TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      ranked_at TEXT NOT NULL,
      usable_until TEXT NOT NULL,
      checked_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_priority_rankings (
      thread_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('now', 'soon', 'later', 'none')),
      confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      reason TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES thread_priority_batches(batch_id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_priority_rankings_batch
    ON thread_priority_rankings(batch_id, thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_priority_batches_usable_until
    ON thread_priority_batches(usable_until)
  `;
});
