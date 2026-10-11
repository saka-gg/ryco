import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { repairProjectionWorktreeTitleColumn, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("031_WorktreeTitles", (it) => {
  it.effect("repairs a migrated database that is missing the title column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 29 });
      yield* sql`
        CREATE TABLE projection_worktrees (
          worktree_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          origin TEXT NOT NULL,
          pr_number INTEGER,
          issue_number INTEGER,
          pr_title TEXT,
          issue_title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          manual_position INTEGER NOT NULL DEFAULT 0
        )
      `;

      yield* repairProjectionWorktreeTitleColumn();
      yield* repairProjectionWorktreeTitleColumn();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_worktrees)
      `;
      assert.include(
        columns.map((column) => column.name),
        "title",
      );
    }),
  );
});
