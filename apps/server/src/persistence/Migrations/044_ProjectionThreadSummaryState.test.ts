import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionThreadSummaryState", (it) => {
  it.effect("backfills durable user-input state and creates summary lookup indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-input-1-requested',
            'thread-1',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"input-1"}',
            NULL,
            '2026-08-12T00:00:00.000Z'
          ),
          (
            'activity-input-1-transient',
            'thread-1',
            NULL,
            'error',
            'provider.user-input.respond.failed',
            'Temporary failure',
            '{"requestId":"input-1","detail":"Provider timed out"}',
            NULL,
            '2026-08-12T00:01:00.000Z'
          ),
          (
            'activity-input-2-requested',
            'thread-1',
            NULL,
            'info',
            'user-input.requested',
            'Input requested',
            '{"requestId":"input-2"}',
            NULL,
            '2026-08-12T00:02:00.000Z'
          ),
          (
            'activity-input-2-stale',
            'thread-1',
            NULL,
            'error',
            'provider.user-input.respond.failed',
            'Stale request',
            '{"requestId":"input-2","detail":"Unknown pending user-input request"}',
            NULL,
            '2026-08-12T00:03:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const stateRows = yield* sql<{
        readonly requestId: string;
        readonly isPending: number;
      }>`
        SELECT
          request_id AS "requestId",
          is_pending AS "isPending"
        FROM projection_thread_user_input_requests
        ORDER BY request_id
      `;
      assert.deepStrictEqual(stateRows, [
        { requestId: "input-1", isPending: 1 },
        { requestId: "input-2", isPending: 0 },
      ]);

      const planIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_proposed_plans)
      `;
      assert.ok(
        planIndexes.some(
          (index) => index.name === "idx_projection_thread_proposed_plans_thread_turn_updated",
        ),
      );
    }),
  );
});
