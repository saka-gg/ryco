import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ensureProjectImportsTable } from "./101_ProjectImports.ts";

const hasTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_imports'`;
  return rows.length === 1;
});

const indexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'project_imports' AND sql IS NOT NULL
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const insertImport = (input: {
  readonly importId: string;
  readonly destinationKey: string;
  readonly status: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_imports (import_id, project_id, destination_key, status,
        input_json, input_digest, snapshot_json, created_at, updated_at)
      VALUES (${input.importId}, 'project', ${input.destinationKey}, ${input.status}, '{}',
        'digest', '{}', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`;
  });

const EXPECTED_INDEXES = ["idx_project_imports_running_destination", "idx_project_imports_status"];

it.layer(NodeSqliteClient.layerMemory())("101 project imports", (it) => {
  it.effect("creates the table, keeps running jobs off one destination, and re-runs cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });
      assert.isFalse(yield* hasTable);

      yield* runMigrations({ toMigrationInclusive: 101 });
      assert.isTrue(yield* hasTable);
      assert.deepEqual(yield* indexes, EXPECTED_INDEXES);

      yield* insertImport({ importId: "a", destinationKey: "/code/app", status: "running" });
      // A second running job for the same destination is refused.
      const conflict = yield* insertImport({
        importId: "b",
        destinationKey: "/code/app",
        status: "running",
      }).pipe(Effect.result);
      assert.equal(conflict._tag, "Failure");
      // Finished jobs keep their key; a new running job may take it again.
      yield* sql`UPDATE project_imports SET status = 'failed' WHERE import_id = 'a'`;
      yield* insertImport({ importId: "c", destinationKey: "/code/app", status: "running" });
      yield* insertImport({ importId: "d", destinationKey: "/code/app", status: "completed" });

      const defaults = yield* sql<{ readonly owned: number; readonly registered: number }>`
        SELECT owned, registered FROM project_imports WHERE import_id = 'c'`;
      assert.deepEqual(defaults, [{ owned: 0, registered: 0 }]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT import_id FROM project_imports WHERE status = 'running'`;
      assert.ok(plan.some((row) => row.detail.includes("USING")));

      // Running everything again (ledger pass plus the repair) leaves table and rows alone.
      yield* runMigrations();
      assert.deepEqual(yield* indexes, EXPECTED_INDEXES);
      const rows = yield* sql<{ readonly import_id: string }>`
        SELECT import_id FROM project_imports ORDER BY import_id`;
      assert.deepEqual(
        rows.map((row) => row.import_id),
        ["a", "c", "d"],
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("101 re-run", (it) => {
  it.effect("reports whether it created the table, so a second run is a no-op", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 100 });
      assert.isTrue(yield* ensureProjectImportsTable);
      assert.isFalse(yield* ensureProjectImportsTable);
      assert.deepEqual(yield* indexes, EXPECTED_INDEXES);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("101 repair", (it) => {
  it.effect("creates the table when another branch recorded 101 first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (101, CURRENT_TIMESTAMP, 'SomeOtherBranch')
      `;
      yield* runMigrations();
      assert.isTrue(yield* hasTable);
      assert.deepEqual(yield* indexes, EXPECTED_INDEXES);
    }),
  );
});
