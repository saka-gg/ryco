import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import WorktreeNotes from "./079_WorktreeNotes.ts";

const readSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{ readonly type: string; readonly name: string }>`
    SELECT type, name FROM sqlite_master
    WHERE (type = 'table' AND name = 'worktree_notes')
       OR (type = 'index' AND tbl_name = 'worktree_notes' AND sql IS NOT NULL)
       OR (type = 'trigger' AND tbl_name = 'worktree_notes')
    ORDER BY type, name
  `;
  return objects.map((object) => `${object.type}:${object.name}`);
});

const PRESENT = ["index:worktree_notes_project_created_id", "table:worktree_notes"];

const insertNote = (noteId: string, scope: string, deletedAt: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO worktree_notes (note_id, project_id, worktree_id, scope, body, thread_id,
        revision, create_digest, created_at, updated_at, deleted_at)
      VALUES (${noteId}, 'project', NULL, ${scope}, 'Body', NULL, 0, 'digest',
        '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z', ${deletedAt})
    `;
  });

it.layer(NodeSqliteClient.layerMemory())("079 worktree notes", (it) => {
  it.effect("creates the table and partial index without triggers, idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      assert.deepEqual(yield* readSchema, []);
      yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepEqual(yield* readSchema, PRESENT);

      yield* insertNote("worktree-note", "worktree");
      yield* insertNote("pinned-note", "project");
      yield* insertNote("deleted-note", "worktree", "2026-10-07T01:00:00.000Z");
      const rejected = yield* Effect.exit(insertNote("thread-note", "thread"));
      assert.strictEqual(rejected._tag, "Failure");

      const index = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE name = 'worktree_notes_project_created_id'
      `;
      assert.match(index[0]?.sql ?? "", /WHERE deleted_at IS NULL/);
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT note_id FROM worktree_notes
        WHERE project_id = 'project' AND deleted_at IS NULL
        ORDER BY created_at DESC, note_id DESC LIMIT 501
      `;
      assert.isTrue(plan.some((row) => row.detail.includes("worktree_notes_project_created_id")));
      // The index covers the tie-break too: no temporary sort.
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));

      yield* WorktreeNotes;
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
      const count = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM worktree_notes
      `;
      assert.strictEqual(count[0]?.count, 3);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("079 repair", (it) => {
  it.effect("creates the table when a later migration was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (79, 'WorktreeNotes')
      `;
      assert.deepEqual(yield* readSchema, []);
      yield* runMigrations();
      assert.deepEqual(yield* readSchema, PRESENT);
    }),
  );
});
