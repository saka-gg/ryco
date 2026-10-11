import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ThreadPriorityRankings", (it) => {
  it.effect("creates an idempotent derived cache without changing thread rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          token_mode, manual_position, created_at, updated_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan
        ) VALUES (
          'thread-before-ranking', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          'balanced', 0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', 0, 0, 0
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'thread_priority_%'
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        ["thread_priority_batches", "thread_priority_rankings"],
      );
      const rows = yield* sql<{ readonly title: string; readonly updatedAt: string }>`
        SELECT title, updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-before-ranking'
      `;
      assert.deepEqual(rows, [{ title: "Existing thread", updatedAt: "2026-08-25T00:00:00.000Z" }]);
    }),
  );
});
