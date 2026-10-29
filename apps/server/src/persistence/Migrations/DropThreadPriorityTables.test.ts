import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { inspectMigrationLedger, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { dropThreadPriorityTables } from "./DropThreadPriorityTables.ts";

/** The ranking tables and their indexes that are still in the schema. */
const rankingObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name LIKE 'thread_priority_%' OR name LIKE 'idx_thread_priority_%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("drop thread priority tables", (it) => {
  it.effect("drops 053's tables and indexes on a full pass and keeps the threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 92 });
      assert.deepEqual(yield* rankingObjects, [
        "idx_thread_priority_batches_usable_until",
        "idx_thread_priority_rankings_batch",
        "thread_priority_batches",
        "thread_priority_rankings",
      ]);
      yield* sql`
        INSERT INTO thread_priority_batches (
          slot, batch_id, input_fingerprint, model_selection_json, model_fingerprint,
          prompt_version, ranked_at, usable_until, checked_at
        ) VALUES (
          1, 'batch-1', 'fingerprint', '{}', 'model', 'v1',
          '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations();
      assert.deepEqual(yield* rankingObjects, []);
      assert.deepEqual((yield* inspectMigrationLedger()).repairsPending, []);

      // Running everything again is a no-op.
      yield* runMigrations();
      assert.deepEqual(yield* rankingObjects, []);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("drop thread priority tables re-run", (it) => {
  it.effect("reports whether it dropped anything, so a second run is a no-op", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 92 });
      assert.isTrue(yield* dropThreadPriorityTables);
      assert.isFalse(yield* dropThreadPriorityTables);
      assert.deepEqual(yield* rankingObjects, []);
    }),
  );
});
