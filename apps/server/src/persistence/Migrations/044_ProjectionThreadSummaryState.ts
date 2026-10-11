import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_user_input_requests (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      is_pending INTEGER NOT NULL CHECK (is_pending IN (0, 1)),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_user_input_requests_thread_pending
    ON projection_thread_user_input_requests(thread_id, is_pending)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_turn_updated
    ON projection_thread_proposed_plans(thread_id, turn_id, updated_at DESC, plan_id DESC)
  `;

  yield* sql`
    INSERT INTO projection_thread_user_input_requests (
      request_id,
      thread_id,
      is_pending,
      updated_at
    )
    SELECT
      latest.request_id,
      latest.thread_id,
      CASE WHEN latest.kind = 'user-input.requested' THEN 1 ELSE 0 END,
      latest.created_at
    FROM (
      SELECT
        json_extract(activity.payload_json, '$.requestId') AS request_id,
        activity.thread_id,
        activity.kind,
        activity.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(activity.payload_json, '$.requestId')
          ORDER BY activity.created_at DESC, activity.activity_id DESC
        ) AS row_number
      FROM projection_thread_activities AS activity
      WHERE json_extract(activity.payload_json, '$.requestId') IS NOT NULL
        AND (
          activity.kind IN ('user-input.requested', 'user-input.resolved')
          OR (
            activity.kind = 'provider.user-input.respond.failed'
            AND (
              lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%stale pending user-input request%'
              OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%unknown pending user-input request%'
            )
          )
        )
    ) AS latest
    WHERE latest.row_number = 1
    ON CONFLICT (request_id)
    DO UPDATE SET
      thread_id = excluded.thread_id,
      is_pending = excluded.is_pending,
      updated_at = excluded.updated_at
  `;
});
