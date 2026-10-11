import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("030_Worktrees", (it) => {
  it.effect("creates projection_worktrees with expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 30 });

      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_worktrees)`;
      const names = cols.map((column) => column.name).toSorted();
      assert.deepStrictEqual(names, [
        "archived_at",
        "branch",
        "created_at",
        "issue_number",
        "issue_title",
        "manual_position",
        "origin",
        "pr_number",
        "pr_title",
        "project_id",
        "title",
        "updated_at",
        "worktree_id",
        "worktree_path",
      ]);
    }),
  );

  it.effect("adds worktree_id, manual_status_bucket, manual_position to projection_threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 30 });

      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      const names = cols.map((column) => column.name);
      assert.include(names, "worktree_id");
      assert.include(names, "manual_status_bucket");
      assert.include(names, "manual_position");
    }),
  );

  it.effect("creates expected indices", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 30 });

      const indices = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN ('projection_worktrees', 'projection_threads')
      `;
      const names = indices.map((index) => index.name);
      assert.include(names, "idx_projection_worktrees_project_archived");
      assert.include(names, "idx_projection_worktrees_pr_lookup");
      assert.include(names, "idx_projection_worktrees_issue_lookup");
      assert.include(names, "idx_projection_threads_worktree_bucket");
    }),
  );
});
