import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const hasDocumentsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes_documents'
  `;
  return tables.length === 1;
});

const insertNote = (
  noteId: string,
  input: {
    readonly project?: string;
    readonly worktreeId?: string | null;
    readonly scope?: string;
    readonly createdAt: string;
    readonly deletedAt?: string | null;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO worktree_notes (note_id, project_id, worktree_id, scope, body, thread_id,
        revision, create_digest, created_at, updated_at, deleted_at)
      VALUES (${noteId}, ${input.project ?? "project"}, ${input.worktreeId ?? null},
        ${input.scope ?? "worktree"}, ${`Body ${noteId}`}, NULL, 0, 'digest',
        ${input.createdAt}, ${input.createdAt}, ${input.deletedAt ?? null})
    `;
  });

const readDocuments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly project: string;
    readonly scope: string;
    readonly key: string;
    readonly body: string;
    readonly revision: number;
    readonly updatedAt: string;
  }>`
    SELECT project_id AS project, scope, worktree_key AS key, body, revision,
      updated_at AS "updatedAt"
    FROM notes_documents ORDER BY project_id, scope, worktree_key
  `;
});

it.layer(NodeSqliteClient.layerMemory())("081 notes documents", (it) => {
  it.effect("folds live legacy notes into one document per scope, oldest first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      assert.isFalse(yield* hasDocumentsTable);
      yield* insertNote("b", { worktreeId: "feature", createdAt: "2026-10-07T02:00:00.000Z" });
      yield* insertNote("a", { worktreeId: "feature", createdAt: "2026-10-07T01:00:00.000Z" });
      yield* insertNote("main", { createdAt: "2026-10-07T01:00:00.000Z" });
      yield* insertNote("pinned", {
        worktreeId: "feature",
        scope: "project",
        createdAt: "2026-10-07T03:00:00.000Z",
      });
      yield* insertNote("gone", {
        worktreeId: "feature",
        createdAt: "2026-10-07T04:00:00.000Z",
        deletedAt: "2026-10-07T05:00:00.000Z",
      });
      yield* insertNote("other", { project: "other", createdAt: "2026-10-07T01:00:00.000Z" });

      yield* runMigrations();
      const folded = [
        {
          project: "other",
          scope: "worktree",
          key: "",
          body: "Body other",
          revision: 1,
          updatedAt: "2026-10-07T01:00:00.000Z",
        },
        {
          project: "project",
          scope: "project",
          key: "",
          body: "Body pinned",
          revision: 1,
          updatedAt: "2026-10-07T03:00:00.000Z",
        },
        {
          project: "project",
          scope: "worktree",
          key: "",
          body: "Body main",
          revision: 1,
          updatedAt: "2026-10-07T01:00:00.000Z",
        },
        {
          project: "project",
          scope: "worktree",
          key: "feature",
          body: "Body a\n\nBody b",
          revision: 1,
          updatedAt: "2026-10-07T02:00:00.000Z",
        },
      ];
      assert.deepEqual(yield* readDocuments, folded);
      // The legacy rows stay untouched.
      const legacy = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM worktree_notes
      `;
      assert.strictEqual(legacy[0]?.count, 6);

      const rejected = yield* Effect.exit(
        sql`INSERT INTO notes_documents (project_id, scope, worktree_key, body, revision, updated_at)
          VALUES ('project', 'project', 'feature', '', 1, '2026-10-07T00:00:00.000Z')`,
      );
      assert.strictEqual(rejected._tag, "Failure");

      yield* runMigrations();
      assert.deepEqual(yield* readDocuments, folded);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("081 repair", (it) => {
  it.effect("creates the table when a later migration was recorded first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (81, 'NotesDocuments')
      `;
      assert.isFalse(yield* hasDocumentsTable);
      yield* runMigrations();
      assert.isTrue(yield* hasDocumentsTable);
    }),
  );
});
