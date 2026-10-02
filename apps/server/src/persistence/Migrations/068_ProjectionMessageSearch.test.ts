import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("068 message substring index", (it) => {
  it.effect(
    "backfills once, follows body lifecycle, rolls back atomically, and survives VACUUM",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        const insert = (
          id: string,
          text: string,
          streaming: number,
          fallback: string | null = null,
        ) => sql`
        INSERT INTO projection_thread_messages(message_id, thread_id, role, text, is_streaming, text_json, created_at, updated_at)
        VALUES(${id}, 'thread', 'assistant', ${text}, ${streaming}, ${fallback}, '2026-01-01', '2026-01-01')
      `;
        yield* insert("old", "old searchable body", 0);
        yield* insert("stream", "old partial body", 1);
        yield* insert("encoded", "old", 0, '"old\\u0000body"');
        yield* runMigrations({ toMigrationInclusive: 68 });
        yield* runMigrations({ toMigrationInclusive: 68 });
        const matches = (query: string) => sql<{ messageId: string }>`
        SELECT ids.message_id AS "messageId" FROM projection_message_search(${query}) AS matches
        JOIN projection_message_search_ids ids ON ids.search_id = matches.rowid
        ORDER BY ids.message_id
      `;
        assert.deepEqual(yield* matches('"old"'), [{ messageId: "old" }]);
        yield* sql`UPDATE projection_thread_messages SET text = 'new completed body', is_streaming = 0 WHERE message_id = 'stream'`;
        yield* sql`UPDATE projection_thread_messages SET text = '', is_streaming = 1 WHERE message_id = 'old'`;
        assert.deepEqual(yield* matches('"old"'), []);
        assert.deepEqual(yield* matches('"new"'), [{ messageId: "stream" }]);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE projection_thread_messages SET text = 'changed' WHERE message_id = 'stream'`;
              assert.deepEqual(yield* matches('"new"'), []);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        assert.deepEqual(yield* matches('"new"'), [{ messageId: "stream" }]);
        yield* insert("later", "new body", 0);
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'stream'`;
        yield* sql`VACUUM`;
        assert.deepEqual(yield* matches('"new"'), [{ messageId: "later" }]);
        // No duplicate message bodies or token positions are stored in this index.
        assert.deepEqual(yield* sql`SELECT text FROM projection_message_search('"new"')`, [
          { text: null },
        ]);
        yield* sql`INSERT INTO projection_message_search(projection_message_search) VALUES('integrity-check')`;
      }),
  );
});
