import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_AtlassianConnections", (it) => {
  it.effect("creates Atlassian connection, resource, and project link tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'atlassian_connections',
            'atlassian_resources',
            'project_atlassian_links'
          )
      `;

      assert.deepStrictEqual(tables.map((table) => table.name).toSorted(), [
        "atlassian_connections",
        "atlassian_resources",
        "project_atlassian_links",
      ]);
    }),
  );

  it.effect("creates lookup indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      const indices = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_atlassian_connections_status',
            'idx_atlassian_resources_connection_product',
            'idx_project_atlassian_links_project'
          )
      `;

      assert.deepStrictEqual(indices.map((index) => index.name).toSorted(), [
        "idx_atlassian_connections_status",
        "idx_atlassian_resources_connection_product",
        "idx_project_atlassian_links_project",
      ]);
    }),
  );

  it.effect("is idempotent when the full migration set is requested again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* runMigrations({ toMigrationInclusive: 36 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'atlassian_connections'
      `;

      assert.strictEqual(tables.length, 1);
    }),
  );
});
