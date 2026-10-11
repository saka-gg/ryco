import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Recency-ordered lookups of a project's threads (e.g. project thread lists
  // and pagination cursors) scan by (project_id, updated_at).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_updated_at
    ON projection_threads(project_id, updated_at)
  `;

  // Orchestration event replay scoped to a single thread stream relies on
  // (stream_id, sequence). The composite (aggregate_kind, stream_id, sequence)
  // index from migration 001 already serves thread streams (aggregate_kind is
  // always constrained for thread reads); this statement is defensive in case
  // an older database was created without it.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_stream_sequence
    ON orchestration_events(aggregate_kind, stream_id, sequence)
  `;
});
