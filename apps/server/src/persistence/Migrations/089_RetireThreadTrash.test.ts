import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const hasMarkersTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_markers'
  `;
  return rows.length === 1;
});

it.layer(NodeSqliteClient.layerMemory())("089 lifecycle markers migration", (it) => {
  it.effect("creates the marker table", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 88 });
      assert.isFalse(yield* hasMarkersTable);
      yield* runMigrations({ toMigrationInclusive: 89 });
      assert.isTrue(yield* hasMarkersTable);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("089 lifecycle markers repair", (it) => {
  it.effect("creates the table when another branch recorded 089 first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (89, CURRENT_TIMESTAMP, 'SomeOtherBranch')
      `;
      yield* runMigrations();
      assert.isTrue(yield* hasMarkersTable);
    }),
  );
});
