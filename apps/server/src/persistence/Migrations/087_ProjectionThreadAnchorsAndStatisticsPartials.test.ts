import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { inheritedTurnRowSql } from "../../orchestration/forkInheritanceSql.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { firstUserMessageIdQuery, latestUserMessageIdQuery } from "../userMessageAnchors.ts";
import { ensureProjectionThreadAnchorsAndStatisticsPartials } from "./087_ProjectionThreadAnchorsAndStatisticsPartials.ts";

const insertThread = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
      pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at, deleted_at
    ) VALUES (
      ${threadId}, 'project', 'Thread', '{"provider":"codex","model":"gpt-5.4"}', 'full-access',
      'default', NULL, NULL, NULL, NULL, 0, 0, 0,
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL
    )
  `;

const insertMessage = (
  sql: SqlClient.SqlClient,
  messageId: string,
  threadId: string,
  role: string,
  createdAt: string,
) =>
  sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES (${messageId}, ${threadId}, NULL, ${role}, 'text', 0, ${createdAt}, ${createdAt})
  `;

const upsertTurn = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: string;
    readonly requestedAt: string;
    readonly completedAt: string | null;
    readonly assistantMessageId?: string | null;
  },
) =>
  sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, assistant_message_id, state, requested_at, completed_at,
      checkpoint_files_json
    ) VALUES (
      ${input.threadId}, ${input.turnId}, ${input.assistantMessageId ?? null}, ${input.state},
      ${input.requestedAt}, ${input.completedAt}, '[]'
    )
    ON CONFLICT (thread_id, turn_id) DO UPDATE SET
      state = excluded.state,
      completed_at = excluded.completed_at,
      assistant_message_id = excluded.assistant_message_id
  `;

const upsertSession = (sql: SqlClient.SqlClient, threadId: string, activeTurnId: string | null) =>
  sql`
    INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
    VALUES (${threadId}, 'running', ${activeTurnId}, '2026-10-01T00:00:00.000Z')
    ON CONFLICT (thread_id) DO UPDATE SET active_turn_id = excluded.active_turn_id
  `;

/** The read rules the columns replace, evaluated directly. */
const expected = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const [first] = yield* firstUserMessageIdQuery(sql, threadId);
    const [latest] = yield* latestUserMessageIdQuery(sql, threadId);
    const [completed] = yield* sql<{ readonly completedAt: string }>`
      SELECT turns.completed_at AS "completedAt"
      FROM projection_turns AS turns
      WHERE turns.thread_id = ${threadId}
        AND turns.state = 'completed'
        AND turns.completed_at IS NOT NULL
        AND NOT ${inheritedTurnRowSql(sql, "turns")}
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_sessions AS sessions
          WHERE sessions.thread_id = turns.thread_id AND sessions.active_turn_id = turns.turn_id
        )
      ORDER BY turns.requested_at DESC, turns.turn_id DESC
      LIMIT 1
    `;
    return {
      first: first?.messageId ?? null,
      latest: latest?.messageId ?? null,
      completedAt: completed?.completedAt ?? null,
    };
  });

const actual = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{
    readonly first: string | null;
    readonly latest: string | null;
    readonly completedAt: string | null;
  }>`
    SELECT
      first_user_message_id AS first,
      latest_user_message_id AS latest,
      latest_completed_turn_at AS "completedAt"
    FROM projection_threads WHERE thread_id = ${threadId}
  `.pipe(Effect.map((rows) => ({ ...rows[0]! })));

const assertParity = (sql: SqlClient.SqlClient, threadId: string, note: string) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* actual(sql, threadId), yield* expected(sql, threadId), note);
  });

it.layer(NodeSqliteClient.layerMemory())("087 thread anchors and statistics partials", (it) => {
  it.effect("backfills existing threads and keeps the columns equal to the read rules", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });
      yield* insertThread(sql, "t1");
      yield* insertMessage(sql, "u1", "t1", "user", "2026-10-01T00:00:01.000Z");
      yield* insertMessage(sql, "a1", "t1", "assistant", "2026-10-01T00:00:02.000Z");
      yield* insertMessage(sql, "u2", "t1", "user", "2026-10-01T00:00:03.000Z");
      yield* upsertTurn(sql, {
        threadId: "t1",
        turnId: "turn-1",
        state: "completed",
        requestedAt: "2026-10-01T00:00:01.000Z",
        completedAt: "2026-10-01T00:00:05.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 87 });
      assert.deepEqual(yield* actual(sql, "t1"), {
        first: "u1",
        latest: "u2",
        completedAt: "2026-10-01T00:00:05.000Z",
      });
      assert.isFalse(yield* ensureProjectionThreadAnchorsAndStatisticsPartials);

      // A later user message with the same timestamp wins by insertion order (rowid).
      yield* insertMessage(sql, "u0", "t1", "user", "2026-10-01T00:00:03.000Z");
      yield* assertParity(sql, "t1", "tie on created_at");
      assert.equal((yield* actual(sql, "t1")).latest, "u0");
      // An earlier message becomes the first anchor.
      yield* insertMessage(sql, "u-early", "t1", "user", "2026-09-30T00:00:00.000Z");
      yield* assertParity(sql, "t1", "earlier insert");
      // Assistant traffic never moves the anchors.
      yield* sql`UPDATE projection_thread_messages SET text = 'more' WHERE message_id = 'a1'`;
      yield* assertParity(sql, "t1", "assistant update");
      // Reverts delete messages; the previous user message becomes the latest again.
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id IN ('u0', 'u2')`;
      yield* assertParity(sql, "t1", "delete latest");
      yield* sql`UPDATE projection_thread_messages SET role = 'system' WHERE message_id = 'u-early'`;
      yield* assertParity(sql, "t1", "role change");
      yield* sql`UPDATE projection_thread_messages SET created_at = '2026-10-02T00:00:00.000Z' WHERE message_id = 'u1'`;
      yield* assertParity(sql, "t1", "created_at change");

      // Turns: a newer completed turn, the session's active turn, and an inherited copy.
      yield* upsertTurn(sql, {
        threadId: "t1",
        turnId: "turn-2",
        state: "running",
        requestedAt: "2026-10-01T00:01:00.000Z",
        completedAt: null,
      });
      yield* assertParity(sql, "t1", "running turn");
      yield* upsertTurn(sql, {
        threadId: "t1",
        turnId: "turn-2",
        state: "completed",
        requestedAt: "2026-10-01T00:01:00.000Z",
        completedAt: "2026-10-01T00:02:00.000Z",
      });
      yield* assertParity(sql, "t1", "turn completed");
      yield* upsertSession(sql, "t1", "turn-2");
      yield* assertParity(sql, "t1", "session holds the turn");
      assert.equal((yield* actual(sql, "t1")).completedAt, "2026-10-01T00:00:05.000Z");
      yield* upsertSession(sql, "t1", null);
      yield* assertParity(sql, "t1", "session released the turn");
      yield* upsertTurn(sql, {
        threadId: "t1",
        turnId: "turn-3",
        state: "completed",
        requestedAt: "2026-10-01T00:03:00.000Z",
        completedAt: "2026-10-01T00:04:00.000Z",
        assistantMessageId: "t1:inherited:source-message",
      });
      yield* assertParity(sql, "t1", "inherited turn");
      yield* sql`DELETE FROM projection_turns WHERE turn_id = 'turn-2'`;
      yield* assertParity(sql, "t1", "turn deleted");
      yield* upsertSession(sql, "t1", "turn-1");
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = 't1'`;
      yield* assertParity(sql, "t1", "session deleted");

      // History written before its thread row (imports): the thread insert computes it.
      yield* insertMessage(sql, "u-import", "t2", "user", "2026-10-01T00:00:01.000Z");
      yield* upsertTurn(sql, {
        threadId: "t2",
        turnId: "turn-import",
        state: "completed",
        requestedAt: "2026-10-01T00:00:01.000Z",
        completedAt: "2026-10-01T00:00:09.000Z",
      });
      yield* insertThread(sql, "t2");
      yield* assertParity(sql, "t2", "thread inserted after its history");
      assert.equal((yield* actual(sql, "t2")).first, "u-import");
      // Thread rows keep the columns through ordinary updates.
      yield* sql`UPDATE projection_threads SET title = 'Renamed' WHERE thread_id = 't2'`;
      yield* assertParity(sql, "t2", "thread update");
    }),
  );

  it.effect("creates the statistics partials tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('statistics_thread_partials', 'statistics_partials_state')
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        ["statistics_partials_state", "statistics_thread_partials"],
      );
    }),
  );
});
