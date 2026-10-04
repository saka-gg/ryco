import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const objectNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name IN (
      'restart_continuations',
      'restart_continuations_pending',
      'restart_continuations_settled',
      'restart_shutdown_hints'
    )
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const insertRow = (input: { readonly kind: string; readonly status: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO restart_continuations (
        thread_id, source_turn_id, kind, status, captured_at, last_observed_at, record_json
      )
      VALUES (
        'thread-1', ${`turn-${input.kind}-${input.status}`}, ${input.kind}, ${input.status},
        '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z', '{}'
      )
    `;
  });

it.layer(NodeSqliteClient.layerMemory())("073 restart continuations migration", (it) => {
  it.effect("creates the ledger, its indexes and the hints table", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 72 });
      assert.deepStrictEqual(yield* objectNames, []);

      yield* runMigrations({ toMigrationInclusive: 73 });
      assert.deepStrictEqual(yield* objectNames, [
        "restart_continuations",
        "restart_continuations_pending",
        "restart_continuations_settled",
        "restart_shutdown_hints",
      ]);

      assert.isTrue(
        (yield* Effect.exit(insertRow({ kind: "crash", status: "pending" })))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.exit(insertRow({ kind: "in-flight", status: "lost" })))._tag === "Failure",
      );
      yield* insertRow({ kind: "in-flight", status: "pending" });
      yield* insertRow({ kind: "background-only", status: "skipped" });
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())(
  "073 restart continuations repair after a later migration",
  (it) => {
    it.effect("creates the tables when 074 was recorded first", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 72 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, created_at, name)
          VALUES (74, CURRENT_TIMESTAMP, 'ProjectionThreadsUsageLimit')
        `;
        yield* runMigrations();
        assert.strictEqual((yield* objectNames).length, 4);
      }),
    );
  },
);
