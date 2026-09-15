import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations, repairProjectionThreadSummaryState } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("056_UserInputResponseClaims", (it) => {
  it.effect(
    "expires legacy questions and preserves modern claims during compatibility repair",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        yield* sql`INSERT INTO projection_thread_user_input_requests
        (thread_id, request_id, is_pending, updated_at) VALUES
        ('thread-a', 'legacy', 1, '2026-09-01T00:00:00.000Z'),
        ('thread-a', 'settled', 0, '2026-09-01T00:00:00.000Z')`;
        yield* runMigrations();
        const rows = yield* sql<{ request_id: string; is_pending: number; response_state: string }>`
        SELECT request_id, is_pending, response_state FROM projection_thread_user_input_requests ORDER BY request_id`;
        assert.deepEqual(rows, [
          { request_id: "legacy", is_pending: 0, response_state: "invalidated" },
          { request_id: "settled", is_pending: 0, response_state: "settled" },
        ]);
        const failures = yield* sql<{
          payload: string;
        }>`SELECT payload_json AS payload FROM projection_thread_activities
        WHERE kind = 'provider.user-input.respond.failed'`;
        assert.equal(failures.length, 1);
        assert.equal(JSON.parse(failures[0]!.payload).responseState, "invalidated");
        yield* sql`INSERT INTO projection_thread_user_input_requests
        (thread_id, request_id, is_pending, updated_at, identity_json, response_attempt_id, response_state)
        VALUES ('thread-b', 'legacy', 1, '2026-09-15T00:00:00.000Z',
          '{"requestEventId":"new-callback","runtimeSessionId":"new-runtime"}', 'claimed-once', 'uncertain')`;
        // A missing compatibility marker/index must not replay the pre-identity backfill.
        yield* sql`DELETE FROM ryco_compatibility_repairs WHERE repair_key = 'projection-thread-summary-v1'`;
        yield* sql`DROP INDEX idx_projection_thread_user_input_requests_thread_pending`;
        yield* repairProjectionThreadSummaryState;
        yield* runMigrations();
        const claim = yield* sql<{ response_attempt_id: string; response_state: string }>`
        SELECT response_attempt_id, response_state FROM projection_thread_user_input_requests WHERE thread_id = 'thread-b'`;
        assert.deepEqual(claim, [
          { response_attempt_id: "claimed-once", response_state: "uncertain" },
        ]);
        const count = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM projection_thread_activities
        WHERE kind = 'provider.user-input.respond.failed'`;
        assert.equal(count[0]?.count, 1);
      }),
  );
});
