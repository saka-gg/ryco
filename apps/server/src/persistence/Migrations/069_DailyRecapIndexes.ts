import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing turn indexes start with thread_id and cannot bound an all-project day query.
  yield* sql`CREATE INDEX idx_projection_turns_completed_at
    ON projection_turns(completed_at, thread_id, state) WHERE completed_at IS NOT NULL`;
  yield* sql`CREATE INDEX idx_projection_threads_pending_attention
    ON projection_threads(thread_id)
    WHERE deleted_at IS NULL AND archived_at IS NULL
      AND (pending_approval_count > 0 OR pending_user_input_count > 0
        OR has_actionable_proposed_plan = 1)`;
  yield* sql`CREATE INDEX idx_projection_thread_sessions_error
    ON projection_thread_sessions(thread_id) WHERE status = 'error'`;
});
