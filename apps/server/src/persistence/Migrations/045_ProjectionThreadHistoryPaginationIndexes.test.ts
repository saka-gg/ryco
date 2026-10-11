import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionThreadHistoryPaginationIndexes", (it) => {
  it.effect("creates indexes for each bounded history order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      const planIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_proposed_plans)
      `;
      const activityIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      const checkpointIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;

      assert.include(
        planIndexes.map((row) => row.name),
        "idx_projection_thread_proposed_plans_thread_created_id",
      );
      assert.include(
        activityIndexes.map((row) => row.name),
        "idx_projection_thread_activities_history_order",
      );
      assert.include(
        checkpointIndexes.map((row) => row.name),
        "idx_projection_turns_thread_checkpoint_order",
      );
    }),
  );
});
