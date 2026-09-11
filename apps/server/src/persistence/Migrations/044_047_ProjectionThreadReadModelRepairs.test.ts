import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { repairProjectionThreadSummaryState, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_047_ProjectionThreadReadModelRepairs", (it) => {
  it.effect("repairs the schema when another worktree recorded migrations 44 through 47", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES
          (44, '2026-08-23T12:52:00.000Z', 'DivergentWorktreeMigration44'),
          (45, '2026-08-23T12:53:00.000Z', 'DivergentWorktreeMigration45'),
          (46, '2026-08-23T12:54:00.000Z', 'DivergentWorktreeMigration46'),
          (47, '2026-08-23T12:55:00.000Z', 'DivergentWorktreeMigration47')
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const requestStateTable = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_user_input_requests'
      `;
      const activityIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      assert.strictEqual(requestStateTable.length, 1);
      assert.ok(
        activityIndexes.some(
          (index) => index.name === "idx_projection_thread_activities_history_order",
        ),
      );
      assert.ok(messageColumns.some((column) => column.name === "dispatch_mode"));
      assert.ok(threadColumns.some((column) => column.name === "goal_json"));
    }),
  );

  it.effect("is idempotent when the repair runs again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(columns.filter((column) => column.name === "goal_json").length, 1);
    }),
  );
});

it.effect("does not replay the history backfill after a successful repair", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, tone, kind, summary, payload_json, created_at
      ) VALUES (
        'input-activity', 'thread', 'info', 'user-input.requested', 'Input requested',
        '{"requestId":"input"}', '2026-09-11T00:00:00.000Z'
      )
    `;
    yield* runMigrations({ toMigrationInclusive: 47 });
    yield* sql`
      CREATE TRIGGER reject_replayed_summary BEFORE INSERT ON projection_thread_user_input_requests
      BEGIN SELECT RAISE(ABORT, 'history backfill was replayed'); END
    `;
    yield* runMigrations({ toMigrationInclusive: 47 });
    const rows = yield* sql`SELECT request_id FROM projection_thread_user_input_requests`;
    assert.deepStrictEqual(rows, [{ request_id: "input" }]);
    // A future divergent checkout may remove the schema. Its repair must still work.
    yield* sql`DROP TABLE projection_thread_user_input_requests`;
    yield* repairProjectionThreadSummaryState;
    const restored = yield* sql`SELECT request_id FROM projection_thread_user_input_requests`;
    assert.deepStrictEqual(restored, rows);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("commits the compatibility marker atomically with the backfill", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* sql`CREATE TABLE ryco_compatibility_repairs (repair_key TEXT PRIMARY KEY)`;
    yield* sql`
      CREATE TRIGGER reject_marker BEFORE INSERT ON ryco_compatibility_repairs
      BEGIN SELECT RAISE(ABORT, 'interrupted repair'); END
    `;
    const failed = yield* Effect.exit(repairProjectionThreadSummaryState);
    assert.isTrue(Exit.isFailure(failed));
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE name = 'projection_thread_user_input_requests'
    `;
    assert.deepStrictEqual(tables, []);
    yield* sql`DROP TRIGGER reject_marker`;
    yield* repairProjectionThreadSummaryState;
    const markers = yield* sql`SELECT repair_key FROM ryco_compatibility_repairs`;
    assert.deepStrictEqual(markers, [{ repair_key: "projection-thread-summary-v1" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
