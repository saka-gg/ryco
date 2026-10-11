import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ProjectionThreadsSettled", (it) => {
  it.effect("adds nullable settlement columns without changing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN settled_override TEXT`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-before-settlement',
          'project-1',
          'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = columns.map((column) => column.name);
      assert.include(names, "settled_override");
      assert.include(names, "settled_at");

      const rows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-before-settlement'
      `;
      assert.deepEqual(rows, [{ settledOverride: null, settledAt: null }]);
    }),
  );

  it.effect("remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = columns.map((column) => column.name);
      assert.equal(names.filter((name) => name === "settled_override").length, 1);
      assert.equal(names.filter((name) => name === "settled_at").length, 1);
    }),
  );
});
