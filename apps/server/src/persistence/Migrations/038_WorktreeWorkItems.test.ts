import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_WorktreeWorkItems", (it) => {
  it.effect("adds work item columns and lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_worktrees)
      `;
      const names = columns.map((column) => column.name);
      assert.include(names, "work_item_provider");
      assert.include(names, "work_item_key");
      assert.include(names, "work_item_title");
      assert.include(names, "work_item_state");
      assert.include(names, "work_item_url");

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_worktrees'
      `;
      assert.include(
        indexes.map((index) => index.name),
        "idx_projection_worktrees_work_item_lookup",
      );
    }),
  );
});
