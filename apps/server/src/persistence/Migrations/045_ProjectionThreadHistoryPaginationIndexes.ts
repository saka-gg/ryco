import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created_id
    ON projection_thread_proposed_plans(thread_id, created_at, plan_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_history_order
    ON projection_thread_activities(
      thread_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END),
      sequence,
      created_at,
      activity_id
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_checkpoint_order
    ON projection_turns(thread_id, checkpoint_turn_count, turn_id)
    WHERE checkpoint_turn_count IS NOT NULL
  `;
});
