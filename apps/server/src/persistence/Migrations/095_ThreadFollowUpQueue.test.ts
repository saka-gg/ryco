import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ensureThreadFollowUpQueueTables } from "./095_ThreadFollowUpQueue.ts";

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('projection_thread_queue_entries', 'projection_thread_queue_holds')
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const columns = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    return rows.map((row) => row.name);
  });

it.layer(NodeSqliteClient.layerMemory())("095 follow-up queue", (it) => {
  it.effect("creates the entry and hold tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      assert.deepEqual(yield* tables, []);

      yield* runMigrations({ toMigrationInclusive: 95 });
      assert.deepEqual(yield* columns("projection_thread_queue_entries"), [
        "thread_id",
        "message_id",
        "position",
        "revision",
        "status",
        "payload_json",
        "created_at",
        "updated_at",
      ]);
      assert.deepEqual(yield* columns("projection_thread_queue_holds"), [
        "thread_id",
        "hold_json",
        "updated_at",
      ]);
      yield* sql`INSERT INTO projection_thread_queue_entries
        (thread_id, message_id, position, revision, status, payload_json, created_at, updated_at)
        VALUES ('thread-1', 'msg-1', 0, 1, 'queued', '{}', '2026-10-24T00:00:00.000Z',
          '2026-10-24T00:00:00.000Z')`;

      // Running everything again (ledger pass plus the repair) keeps the tables and their rows.
      yield* runMigrations();
      const rows = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_queue_entries`;
      assert.deepEqual(
        rows.map((row) => row.messageId),
        ["msg-1"],
      );
      // Shells read a thread's head through the order index.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT status FROM projection_thread_queue_entries
        WHERE thread_id = 'thread-1' ORDER BY position ASC LIMIT 1`;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_thread_queue_entries_position")),
      );
    }),
  );

  it.effect("reports whether it created the tables, so a second run is a no-op", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* ensureThreadFollowUpQueueTables);
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("095 repair", (it) => {
  it.effect("creates the tables when another branch recorded 095 first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (95, CURRENT_TIMESTAMP, 'SomethingElse')
      `;
      yield* runMigrations();
      assert.deepEqual(yield* tables, [
        "projection_thread_queue_entries",
        "projection_thread_queue_holds",
      ]);
    }),
  );
});
