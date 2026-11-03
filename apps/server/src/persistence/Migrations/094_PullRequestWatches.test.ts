import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ensurePullRequestWatchesTable } from "./094_PullRequestWatches.ts";

const hasTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_pull_request_watches'
  `;
  return rows.length === 1;
});

const columns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_pull_request_watches)
  `;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("094 pull request watches", (it) => {
  it.effect("creates the table with its full state, shell summary and active count", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });
      assert.isFalse(yield* hasTable);

      yield* runMigrations({ toMigrationInclusive: 94 });
      assert.deepEqual(yield* columns, [
        "thread_id",
        "watches_json",
        "summary_json",
        "active_count",
        "updated_at",
      ]);
      yield* sql`INSERT INTO projection_thread_pull_request_watches
        (thread_id, watches_json, summary_json, active_count, updated_at)
        VALUES ('thread-1', '{}', '{}', 1, '2026-10-24T00:00:00.000Z')`;

      // Running everything again (ledger pass plus the repair) keeps the table and its rows.
      yield* runMigrations();
      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM projection_thread_pull_request_watches`;
      assert.deepEqual(
        rows.map((row) => row.threadId),
        ["thread-1"],
      );
      // The sweep's and the settlement queries' lookup of watched threads uses the partial index.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM projection_thread_pull_request_watches WHERE active_count > 0`;
      assert.ok(
        plan.some((row) =>
          row.detail.includes("idx_projection_thread_pull_request_watches_active"),
        ),
      );
    }),
  );

  it.effect("reports whether it created the table, so a second run is a no-op", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* ensurePullRequestWatchesTable);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("094 repair", (it) => {
  it.effect("creates the table when another branch recorded 094 first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });
      // The cross-node project copy branch numbers its migration 094 too; a dev database that
      // ran that branch recorded it, so the migrator skips this one.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (94, CURRENT_TIMESTAMP, 'ProjectImports')
      `;
      yield* runMigrations();
      assert.isTrue(yield* hasTable);
      assert.include(yield* columns, "summary_json");
    }),
  );
});
