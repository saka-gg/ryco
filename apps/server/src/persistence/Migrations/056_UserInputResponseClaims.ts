import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_user_input_requests RENAME TO questions_before_claims`;
  yield* sql`CREATE TABLE projection_thread_user_input_requests (
    thread_id TEXT NOT NULL, request_id TEXT NOT NULL, is_pending INTEGER NOT NULL,
    updated_at TEXT NOT NULL, identity_json TEXT, response_attempt_id TEXT,
    response_state TEXT, settlement_requires_identity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, request_id)
  )`;
  // Callbacks from before this process have no verifiable owner. Preserve their
  // history, but never describe expiration as an answer accepted by the provider.
  yield* sql`INSERT INTO projection_thread_activities
    (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    SELECT 'question-migration:' || thread_id || ':' || request_id, thread_id, NULL, 'info',
      'provider.user-input.respond.failed', 'Question expired during upgrade',
      json_object('requestId', request_id, 'responseState', 'invalidated',
        'detail', 'Stale pending user-input request: callback identity was not persisted. Restart the turn to continue.'),
      COALESCE((SELECT MAX(a.sequence) FROM projection_thread_activities a WHERE a.thread_id = questions_before_claims.thread_id), 0) + 1,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM questions_before_claims WHERE is_pending = 1`;
  yield* sql`INSERT INTO projection_thread_user_input_requests
    (thread_id, request_id, is_pending, updated_at, response_state)
    SELECT thread_id, request_id, 0, updated_at,
      CASE WHEN is_pending = 1 THEN 'invalidated' ELSE 'settled' END
    FROM questions_before_claims`;
  yield* sql`UPDATE projection_threads SET pending_user_input_count = 0
    WHERE thread_id IN (SELECT thread_id FROM questions_before_claims WHERE is_pending = 1)`;
  yield* sql`DROP TABLE questions_before_claims`;
  yield* sql`CREATE INDEX idx_projection_thread_user_input_requests_thread_pending
    ON projection_thread_user_input_requests(thread_id, is_pending)`;
});
