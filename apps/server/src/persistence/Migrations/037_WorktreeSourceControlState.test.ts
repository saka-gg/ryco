import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_WorktreeSourceControlState", (it) => {
  it.effect("adds pr_state, pr_is_draft, and issue_state columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_worktrees)
      `;
      const names = columns.map((column) => column.name);
      assert.include(names, "pr_state");
      assert.include(names, "pr_is_draft");
      assert.include(names, "issue_state");
    }),
  );

  it.effect("is idempotent — running twice does not error", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* runMigrations({ toMigrationInclusive: 37 });
    }),
  );
});
