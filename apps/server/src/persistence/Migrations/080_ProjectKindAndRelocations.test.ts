import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectKindAndRelocations from "./080_ProjectKindAndRelocations.ts";

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

it.layer(NodeSqliteClient.layerMemory())("080 project kind and relocations", (it) => {
  it.effect("reads existing projects as regular projects and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepEqual(yield* readSchema, ABSENT);
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
          created_at, updated_at)
        VALUES ('existing', 'Existing', '/tmp/existing', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 80 });
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

it.layer(NodeSqliteClient.layerMemory())("080 journal title", (it) => {
  it.effect("adds the title column to a journal created without it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      // The journal as an earlier build of this migration created it.
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

it.layer(NodeSqliteClient.layerMemory())("080 repair", (it) => {
  it.effect("adds the schema when another 080 was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (80, 'SomeParallelBranch')
      `;
      assert.deepEqual(yield* readSchema, ABSENT);
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
    }),
  );
});

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: number; readonly name: string }>`
    SELECT migration_id AS id, name FROM effect_sql_migrations
    WHERE migration_id BETWEEN 79 AND 80 ORDER BY migration_id
  `;
  return rows.map((row) => `${row.id}_${row.name}`);
});

const hasWorktreeNotes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worktree_notes'
  `;
  return tables.length === 1;
});

const insertProject = (projectId: string, kind?: "chat") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (kind === undefined) {
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
          created_at, updated_at)
        VALUES (${projectId}, 'Project', ${`/tmp/${projectId}`}, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      return;
    }
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
        created_at, updated_at, kind)
      VALUES (${projectId}, 'Chat', ${`/tmp/${projectId}`}, '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${kind})
    `;
  });

const readKinds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly projectId: string; readonly kind: string }>`
    SELECT project_id AS "projectId", kind FROM projection_projects ORDER BY project_id
  `;
  return rows.map((row) => `${row.projectId}:${row.kind}`);
});

// Every ledger a database can carry into this build: 079 is main's worktree notes and 080 is
// project kinds, but development databases from the projectless-chats branch recorded project
// kinds as 079 before the renumbering, so the migrator skips main's 079 there.
it.layer(NodeSqliteClient.layerMemory())("080 on a fresh database", (it) => {
  it.effect("records 079 worktree notes then 080 project kinds", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepEqual(yield* readLedger, ["79_WorktreeNotes", "80_ProjectKindAndRelocations"]);
      assert.deepEqual(yield* readSchema, PRESENT);
      assert.isTrue(yield* hasWorktreeNotes);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("080 after main's 079", (it) => {
  it.effect("adds project kinds and keeps existing projects and notes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepEqual(yield* readLedger, ["79_WorktreeNotes"]);
      yield* insertProject("existing");
      yield* sql`
        INSERT INTO worktree_notes (note_id, project_id, worktree_id, scope, body, thread_id,
          revision, create_digest, created_at, updated_at, deleted_at)
        VALUES ('note', 'existing', NULL, 'worktree', 'Body', NULL, 0, 'digest',
          '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z', NULL)
      `;

      yield* runMigrations();
      assert.deepEqual(yield* readLedger, ["79_WorktreeNotes", "80_ProjectKindAndRelocations"]);
      assert.deepEqual(yield* readSchema, PRESENT);
      assert.deepEqual(yield* readKinds, ["existing:project"]);
      const notes = yield* sql<{ readonly noteId: string }>`
        SELECT note_id AS "noteId" FROM worktree_notes
      `;
      assert.deepEqual(notes, [{ noteId: "note" }]);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("080 after the branch's former 079", (it) => {
  it.effect("creates worktree notes and keeps chats and the relocation journal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      // What the projectless-chats branch recorded before its migration became 080.
      yield* ProjectKindAndRelocations;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (79, 'ProjectKindAndRelocations')
      `;
      yield* insertProject("chat", "chat");
      yield* insertProject("existing");
      yield* sql`
        INSERT INTO project_relocations (relocation_id, project_id, source_path,
          destination_path, strategy, state, title, created_at, updated_at)
        VALUES ('r1', 'chat', '/chats/a', '/code/a', 'rename', 'moved', 'Title',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      assert.isFalse(yield* hasWorktreeNotes);

      yield* runMigrations();
      assert.deepEqual(yield* readLedger, [
        "79_ProjectKindAndRelocations",
        "80_ProjectKindAndRelocations",
      ]);
      assert.isTrue(yield* hasWorktreeNotes);
      assert.deepEqual(yield* readSchema, PRESENT);
      assert.deepEqual(yield* readKinds, ["chat:chat", "existing:project"]);
      const journal = yield* sql<{ readonly state: string; readonly title: string }>`
        SELECT state, title FROM project_relocations WHERE relocation_id = 'r1'
      `;
      assert.deepEqual(journal, [{ state: "moved", title: "Title" }]);

      // A later boot is a no-op.
      yield* runMigrations();
      assert.deepEqual(yield* readLedger, [
        "79_ProjectKindAndRelocations",
        "80_ProjectKindAndRelocations",
      ]);
    }),
  );
});
