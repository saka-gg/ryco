import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { decodeMessageText, messageTextColumns } from "../messageText.ts";

it.effect("upgrades schema 60 NUL bodies once and keeps ordinary completed reads raw", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 60 });
    const bodies = ['ordinary 漢字 🚀 "quoted" \\ body', "before\0after", "lone\ud800"];
    for (const [index, text] of bodies.entries()) {
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, text_json, is_streaming, created_at, updated_at)
        VALUES (${String(index)}, 'thread', NULL, 'assistant', ${text},
        ${index === 2 ? JSON.stringify(text) : null}, 0, 'now', 'now')`;
    }
    yield* runMigrations();
    yield* runMigrations();
    const rows = yield* sql<{ text: string; assembledText: string | null }>`
      SELECT ${messageTextColumns(sql, "m")} FROM projection_thread_messages m ORDER BY message_id`;
    assert.equal(rows[0]!.assembledText, null);
    assert.equal(rows[0]!.text, bodies[0]);
    assert.deepEqual(
      rows.map((row) =>
        row.assembledText === null ? row.text : decodeMessageText(row.assembledText),
      ),
      bodies,
    );
    const bounded = yield* sql<{ text: string; assembledText: string | null }>`
      SELECT ${messageTextColumns(sql, "m", 8)} FROM projection_thread_messages m WHERE message_id = '0'`;
    assert.equal(bounded[0]!.text, "ordinary");
    assert.equal(bounded[0]!.assembledText, null);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects future schemas before running migrations or repairs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 59 });
    const future = Math.max(...migrationEntries.map(([id]) => id)) + 1;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (${future}, 'now', 'FutureSchema')`;
    const before = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
    const result = yield* runMigrations().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.match(String(result.failure), /newer than this binary supports/);
    assert.deepEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, before);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
