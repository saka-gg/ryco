import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const tableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE (type = 'table' AND name = 'provider_effect_intents')
       OR (type = 'index' AND name = 'provider_effect_intents_thread_kind')
  `;
  return rows.length;
});

const insertIntent = (kind: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_effect_intents (sequence, event_id, thread_id, kind, recorded_at)
      VALUES (1, 'event-1', 'thread-1', ${kind}, '2026-10-04T00:00:00.000Z')
    `;
  });

it.layer(NodeSqliteClient.layerMemory())("073 provider effect intents migration", (it) => {
  it.effect("creates the ledger and rejects unknown kinds", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 72 });
      assert.strictEqual(yield* tableCount, 0);

      yield* runMigrations({ toMigrationInclusive: 73 });
      assert.strictEqual(yield* tableCount, 2);

      const rejected = yield* Effect.exit(insertIntent("checkpoint-revert"));
      assert.isTrue(rejected._tag === "Failure");
      yield* insertIntent("turn-start");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly attempts: number; readonly dispatchedAt: null }>`
        SELECT recovery_attempts AS attempts, dispatched_at AS "dispatchedAt"
        FROM provider_effect_intents
      `;
      assert.deepStrictEqual(rows, [{ attempts: 0, dispatchedAt: null }]);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())(
  "073 provider effect intents repair after a later migration",
  (it) => {
    it.effect("creates the ledger when a later migration number was recorded first", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 72 });
        // A database that ran a later-numbered migration before 073 landed: the
        // migrator never runs 073 there, so the repair must create the ledger.
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, created_at, name)
          VALUES (75, CURRENT_TIMESTAMP, 'ProjectionThreadsUsageLimit')
        `;
        yield* runMigrations();
        assert.strictEqual(yield* tableCount, 2);
      }),
    );
  },
);
