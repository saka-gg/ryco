import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const columns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('thread_forks')
  `;
  return rows.map((row) => row.name);
});

it.layer(NodeSqliteClient.layerMemory())("098 thread fork origin", (it) => {
  it.effect("adds a nullable origin column to the fork ledger and keeps existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      assert.isFalse((yield* columns).includes("origin_json"));
      yield* sql`INSERT INTO thread_forks (
          fork_key, request_digest, fork_thread_id, source_thread_id, source_message_id,
          destination_kind, phase, plan_json, created_at, updated_at
        ) VALUES (
          'fork-key-before-098-0001', 'digest', 'fork-thread', 'source-thread', 'message',
          'new-chat', 'completed', '{}', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z'
        )`;

      yield* runMigrations({ toMigrationInclusive: 98 });
      assert.isTrue((yield* columns).includes("origin_json"));
      const before = yield* sql<{ readonly origin: string | null }>`
        SELECT origin_json AS "origin" FROM thread_forks`;
      // A fork made before 098 was a fork of a thread on this node.
      assert.deepEqual(before, [{ origin: null }]);

      // Running everything again (ledger pass plus the repair) keeps the column and its rows.
      yield* runMigrations();
      assert.isTrue((yield* columns).includes("origin_json"));
      const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM thread_forks`;
      assert.equal(count[0]?.count, 1);
    }),
  );
});
