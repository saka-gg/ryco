import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionThreadsUsageLimit from "./075_ProjectionThreadsUsageLimit.ts";

const readSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_projection_threads_usage_limited'
  `;
  return {
    hasColumn: columns.some((column) => column.name === "usage_limit_json"),
    hasIndex: indexes.length === 1,
  };
});

it.layer(NodeSqliteClient.layerMemory())("075 projection thread usage limit", (it) => {
  it.effect("adds the column and partial index, and is a no-op when run again", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 70 });
      assert.deepEqual(yield* readSchema, { hasColumn: false, hasIndex: false });
      yield* runMigrations({ toMigrationInclusive: 75 });
      assert.deepEqual(yield* readSchema, { hasColumn: true, hasIndex: true });
      yield* ProjectionThreadsUsageLimit;
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, { hasColumn: true, hasIndex: true });
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("075 repair", (it) => {
  it.effect("adds the column when a later migration was recorded first and 075 was skipped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      // A build that shipped a higher id before 075: the migrator now skips 075.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (75, 'ProjectionThreadsUsageLimit')
      `;
      assert.deepEqual(yield* readSchema, { hasColumn: false, hasIndex: false });
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, { hasColumn: true, hasIndex: true });
    }),
  );
});
