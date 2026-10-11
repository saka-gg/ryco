import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ContextHandoffDeliveryArtifact", (it) => {
  it.effect("repairs a divergent migration 42 before adding the artifact column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (42, '2026-07-31T12:05:37.000Z', 'ProjectionThreadsSettled')
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_context_handoffs)
      `;
      assert.ok(columns.some((column) => column.name === "delivery_artifact_json"));
    }),
  );

  it.effect("adds a nullable immutable delivery-artifact column to legacy rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO provider_context_handoffs (
          handoff_id, thread_id, source_selection_json,
          target_selection_json, status, context_version,
          first_message_id, created_at, updated_at
        ) VALUES (
          'handoff-legacy', 'thread-legacy',
          '{"instanceId":"codex","model":"gpt-5.6"}',
          '{"instanceId":"claudeAgent","model":"claude-fable-5"}',
          'requested', 1, 'message-1',
          '2026-08-05T10:00:00.000Z', '2026-08-05T10:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_context_handoffs)
      `;
      assert.ok(columns.some((column) => column.name === "delivery_artifact_json"));
      const rows = yield* sql<{ readonly deliveryArtifact: string | null }>`
        SELECT delivery_artifact_json AS "deliveryArtifact"
        FROM provider_context_handoffs
        WHERE handoff_id = 'handoff-legacy'
      `;
      assert.deepStrictEqual(rows, [{ deliveryArtifact: null }]);
    }),
  );
});
