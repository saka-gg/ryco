import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_pending_approvals RENAME TO approval_rows_before_claims`;
  yield* sql`CREATE TABLE projection_pending_approvals (
    thread_id TEXT NOT NULL, request_id TEXT NOT NULL, turn_id TEXT,
    status TEXT NOT NULL, decision TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
    identity_json TEXT, response_attempt_id TEXT, response_state TEXT, settlement_requires_identity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, request_id)
  )`;
  // Historical resolved rows stay settled. Legacy pending callbacks require a fresh
  // request before they can acquire a modern runtime-scoped claim.
  yield* sql`INSERT INTO projection_pending_approvals
    (thread_id, request_id, turn_id, status, decision, created_at, resolved_at)
    SELECT thread_id, request_id, turn_id, status, decision, created_at, resolved_at
    FROM approval_rows_before_claims`;
  yield* sql`INSERT INTO projection_thread_activities
    (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    SELECT 'approval-migration:' || request_id, thread_id, turn_id, 'error',
      'provider.approval.respond.failed', 'Approval callback expired during upgrade',
      json_object('requestId', request_id, 'detail', 'Stale pending approval request: callback identity was not persisted. Restart the turn to continue.'),
      COALESCE((SELECT MAX(a.sequence) FROM projection_thread_activities a WHERE a.thread_id = approval_rows_before_claims.thread_id), 0) + 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM approval_rows_before_claims WHERE status = 'pending'`;
  yield* sql`UPDATE projection_pending_approvals SET status = 'resolved', decision = NULL,
    response_state = 'invalidated', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'pending'`;
  yield* sql`UPDATE projection_threads SET pending_approval_count = 0
    WHERE thread_id IN (SELECT thread_id FROM approval_rows_before_claims WHERE status = 'pending')`;
  yield* sql`DROP TABLE approval_rows_before_claims`;
});
