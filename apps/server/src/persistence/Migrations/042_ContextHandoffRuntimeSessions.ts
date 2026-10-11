import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const runtimeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!runtimeColumns.some((column) => column.name === "runtime_session_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN runtime_session_id TEXT
    `;
  }

  const projectionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!projectionColumns.some((column) => column.name === "runtime_session_id")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN runtime_session_id TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_context_handoffs (
      handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_selection_json TEXT NOT NULL,
      target_selection_json TEXT NOT NULL,
      source_runtime_session_id TEXT,
      target_runtime_session_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'requested',
          'preparing',
          'dispatching',
          'consumed',
          'failed',
          'delivery-uncertain'
        )
      ),
      context_version INTEGER NOT NULL,
      structured_context_json TEXT,
      context_digest TEXT,
      first_message_id TEXT NOT NULL,
      accepted_provider_turn_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_context_handoffs_thread_status_created
    ON provider_context_handoffs(thread_id, status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_epoch
    ON provider_session_runtime(runtime_session_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_epoch
    ON projection_thread_sessions(runtime_session_id)
  `;
});
