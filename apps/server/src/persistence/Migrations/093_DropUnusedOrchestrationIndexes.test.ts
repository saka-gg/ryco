import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { dropUnusedOrchestrationIndexes } from "./093_DropUnusedOrchestrationIndexes.ts";

const DROPPED = [
  "idx_orch_command_receipts_aggregate",
  "idx_orch_command_receipts_sequence",
  "idx_orch_events_command_id",
  "idx_orch_events_correlation_id",
];

const KEPT = [
  "idx_orch_events_statistics_usage",
  "idx_orch_events_stream_sequence",
  "idx_orch_events_stream_version",
];

/** Explicitly created (non-automatic) indexes on the two orchestration tables. */
const orchestrationIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND sql IS NOT NULL
      AND tbl_name IN ('orchestration_events', 'orchestration_command_receipts')
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("093 drop unused orchestration indexes", (it) => {
  it.effect("drops the four unused indexes and keeps the ones queries use", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 92 });
      const before = yield* orchestrationIndexes;
      for (const name of [...DROPPED, ...KEPT]) assert.include(before, name);

      yield* runMigrations({ toMigrationInclusive: 93 });
      const after = yield* orchestrationIndexes;
      assert.deepEqual(after, KEPT);

      // Running everything again (ledger pass plus the repair) leaves the same indexes.
      yield* runMigrations();
      assert.deepEqual(yield* orchestrationIndexes, KEPT);

      // Rows survive the drop and the primary-key lookup on receipts still works.
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
        VALUES ('command-1', 'thread', 'thread-1', '2026-10-01T00:00:00.000Z', 1, 'accepted')`;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT status FROM orchestration_command_receipts WHERE command_id = 'command-1'`;
      assert.ok(plan.some((row) => row.detail.includes("USING INDEX")));
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("093 re-run", (it) => {
  it.effect("reports whether it dropped anything, so a second run is a no-op", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 92 });
      assert.isTrue(yield* dropUnusedOrchestrationIndexes);
      assert.isFalse(yield* dropUnusedOrchestrationIndexes);
      assert.deepEqual(yield* orchestrationIndexes, KEPT);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("093 repair", (it) => {
  it.effect("drops the indexes when another branch recorded 093 first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 92 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (93, CURRENT_TIMESTAMP, 'SomeOtherBranch')
      `;
      yield* runMigrations();
      assert.deepEqual(yield* orchestrationIndexes, KEPT);
    }),
  );
});
