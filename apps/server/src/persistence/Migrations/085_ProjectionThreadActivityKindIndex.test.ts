import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  selectStatisticsTokenActivities,
  selectStatisticsToolUses,
} from "../../statistics/StatisticsQuery.ts";
import { describeStartupPhasesOverlapping } from "../../startupStallMonitor.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ensureProjectionThreadActivityKindIndex } from "./085_ProjectionThreadActivityKindIndex.ts";

const activityIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
  }>`PRAGMA index_list(projection_thread_activities)`;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("085 activity kind index", (it) => {
  it.effect("replaces the redundant thread/sequence prefix index with a kind-led one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 84 });
      const before = yield* activityIndexes;
      assert.include(before, "idx_projection_thread_activities_thread_sequence");
      assert.notInclude(before, "idx_projection_thread_activities_kind_order");

      yield* runMigrations({ toMigrationInclusive: 85 });
      const after = yield* activityIndexes;
      assert.include(after, "idx_projection_thread_activities_kind_order");
      // 008's index is a strict prefix of 029's: the b-tree count per activity is unchanged.
      assert.notInclude(after, "idx_projection_thread_activities_thread_sequence");
      assert.include(after, "idx_projection_thread_activities_thread_sequence_created_id");
      assert.equal(after.length, before.length);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_activities_kind_order')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["kind", "thread_id", "sequence", "created_at", "activity_id"],
      );
      // Idempotent: also runs as a post-migrator repair.
      assert.isFalse(yield* ensureProjectionThreadActivityKindIndex);

      // Queries that led with the dropped index still search by thread.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT activity_id FROM projection_thread_activities
        WHERE thread_id = 'thread' ORDER BY sequence DESC LIMIT 50
      `;
      assert.isTrue(
        plan.some((row) =>
          /SEARCH projection_thread_activities USING .*thread_id=\?/.test(row.detail),
        ),
        JSON.stringify(plan),
      );
    }),
  );

  // The statistics rebuild filters the largest table by kind, unscoped (first rebuild after boot
  // or an external commit) and scoped to dirty threads. Both shapes must search this index rather
  // than scan every activity row; no second kind index is needed for them.
  it.effect("serves both statistics activity queries, unscoped and thread-scoped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const kindSearch = (scoped: boolean) =>
        new RegExp(
          `SEARCH (projection_thread_activities|a) USING (COVERING )?INDEX idx_projection_thread_activities_kind_order \\(kind=\\?${scoped ? " AND thread_id=\\?" : ""}\\)`,
        );
      for (const scope of [null, '["thread"]'] as const) {
        const toolPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN ${selectStatisticsToolUses(sql, scope)}
        `;
        assert.isTrue(
          toolPlan.some((row) => kindSearch(scope !== null).test(row.detail)),
          JSON.stringify(toolPlan),
        );
        assert.isFalse(
          toolPlan.some((row) => row.detail.startsWith("SCAN projection_thread_activities")),
          JSON.stringify(toolPlan),
        );
        const tokenPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN ${selectStatisticsTokenActivities(sql, scope)}
        `;
        assert.isTrue(
          tokenPlan.some((row) => kindSearch(scope !== null).test(row.detail)),
          JSON.stringify(tokenPlan),
        );
        assert.isFalse(
          tokenPlan.some((row) => /^SCAN (projection_thread_activities|a)\b/.test(row.detail)),
          JSON.stringify(tokenPlan),
        );
      }
    }),
  );

  it.effect("names the ledger pass and the repairs as startup phases", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const phases = describeStartupPhasesOverlapping(Date.now(), 60_000);
      assert.isTrue(
        phases.some((phase) => phase.startsWith("persistence.migrations.ledger ")),
        JSON.stringify(phases),
      );
      assert.isTrue(
        phases.some((phase) => phase.startsWith("persistence.migrations.repairs ")),
        JSON.stringify(phases),
      );
    }),
  );
});
