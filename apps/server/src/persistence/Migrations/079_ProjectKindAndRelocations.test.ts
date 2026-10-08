import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectKindAndRelocations from "./079_ProjectKindAndRelocations.ts";

const readSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_projects)`;
  const objects = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name IN ('project_relocations', 'idx_project_relocations_state')
    ORDER BY name
  `;
  return {
    kind: projectColumns.some((column) => column.name === "kind"),
    journal: objects.map((object) => object.name),
  };
});

const ABSENT = { kind: false, journal: [] };
const PRESENT = { kind: true, journal: ["idx_project_relocations_state", "project_relocations"] };

it.layer(NodeSqliteClient.layerMemory())("079 project kind and relocations", (it) => {
  it.effect("reads existing projects as regular projects and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      assert.deepEqual(yield* readSchema, ABSENT);
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
          created_at, updated_at)
        VALUES ('existing', 'Existing', '/tmp/existing', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepEqual(yield* readSchema, PRESENT);
      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM projection_projects WHERE project_id = 'existing'
      `;
      assert.deepEqual(rows, [{ kind: "project" }]);

      yield* ProjectKindAndRelocations;
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
    }),
  );

  it.effect("constrains the relocation journal's strategy and state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO project_relocations (relocation_id, project_id, source_path,
          destination_path, strategy, state, created_at, updated_at)
        VALUES ('r1', 'p', '/chats/a', '/code/a', 'rename', 'pending',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      const rows = yield* sql<{ readonly destinationCreated: number; readonly error: null }>`
        SELECT destination_created AS "destinationCreated", error
        FROM project_relocations WHERE relocation_id = 'r1'
      `;
      assert.deepEqual(rows, [{ destinationCreated: 0, error: null }]);
      const invalid = yield* Effect.result(
        sql`
          INSERT INTO project_relocations (relocation_id, project_id, source_path,
            destination_path, strategy, state, created_at, updated_at)
          VALUES ('r2', 'p', '/chats/b', '/code/b', 'symlink', 'pending',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `,
      );
      assert.strictEqual(invalid._tag, "Failure");
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("079 journal title", (it) => {
  it.effect("adds the title column to a journal created without it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      // The journal as an earlier build of 079 created it.
      yield* sql`CREATE TABLE project_relocations (
        relocation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        strategy TEXT NOT NULL CHECK (strategy IN ('rename', 'copy')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'moved', 'done', 'failed')),
        destination_created INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
      yield* ProjectKindAndRelocations;
      yield* ProjectKindAndRelocations;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(project_relocations)`;
      assert.isTrue(columns.some((column) => column.name === "title"));
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("079 repair", (it) => {
  it.effect("adds the schema when another 079 was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (79, 'SomeParallelBranch')
      `;
      assert.deepEqual(yield* readSchema, ABSENT);
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
    }),
  );
});
