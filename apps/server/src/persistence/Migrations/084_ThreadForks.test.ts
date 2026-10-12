import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const objectNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name IN ('thread_forks', 'thread_forks_unfinished')
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("084 thread fork ledger migration", (it) => {
  it.effect("creates the ledger and its unfinished-phase index", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 82 });
      assert.deepStrictEqual(yield* objectNames, []);

      yield* runMigrations({ toMigrationInclusive: 84 });
      assert.deepStrictEqual(yield* objectNames, ["thread_forks", "thread_forks_unfinished"]);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("084 thread fork ledger repair", (it) => {
  it.effect("creates the ledger when a later migration was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (84, CURRENT_TIMESTAMP, 'SomeOtherBranch')
      `;
      yield* runMigrations();
      assert.deepStrictEqual(yield* objectNames, ["thread_forks", "thread_forks_unfinished"]);
    }),
  );
});
