import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_WorktreeWorkItemStateNames", (it) => {
  it.effect("adds work item state name column to projection worktrees", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_worktrees)
      `;
      const names = columns.map((column) => column.name);

      assert.include(names, "work_item_state_name");
    }),
  );
});
