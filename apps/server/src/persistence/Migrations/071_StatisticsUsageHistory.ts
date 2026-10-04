import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Context activities can be overwritten in the projection. Keep statistics
  // reads over their durable event history independent of message volume.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_statistics_usage
    ON orchestration_events (
      stream_id,
      json_extract(payload_json, '$.activity.id'),
      json_extract(payload_json, '$.activity.createdAt')
    )
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') = 'context-window.updated'
  `;
});
