import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ensureGuardedLatestCompletedTurnTrigger } from "./091_GuardedLatestCompletedTurnTrigger.ts";

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

/** Mirrors ProjectionTurns.upsertByTurnId: every watched column is in the DO UPDATE SET. */
const upsertTurn = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: string;
    readonly requestedAt: string;
    readonly completedAt: string | null;
  },
) =>
  sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, assistant_message_id, state, requested_at, completed_at,
      checkpoint_files_json
    ) VALUES (
      ${input.threadId}, ${input.turnId}, NULL, ${input.state}, ${input.requestedAt},
      ${input.completedAt}, '[]'
    )
    ON CONFLICT (thread_id, turn_id) DO UPDATE SET
      assistant_message_id = excluded.assistant_message_id,
      state = excluded.state,
      requested_at = excluded.requested_at,
      completed_at = excluded.completed_at
  `;

const latestCompletedTurnAt = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly completedAt: string | null }>`
    SELECT latest_completed_turn_at AS "completedAt"
    FROM projection_threads WHERE thread_id = ${threadId}
  `.pipe(Effect.map((rows) => rows[0]?.completedAt ?? null));

/** Counts projection_threads rewrites, which only the summary triggers perform here. */
const installThreadWriteProbe = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE thread_write_probe (writes INTEGER NOT NULL)`;
    yield* sql`INSERT INTO thread_write_probe (writes) VALUES (0)`;
    yield* sql.unsafe(`
      CREATE TRIGGER thread_write_probe_update AFTER UPDATE ON projection_threads
      BEGIN UPDATE thread_write_probe SET writes = writes + 1; END
    `);
  });

const threadWrites = (sql: SqlClient.SqlClient) =>
  sql<{ readonly writes: number }>`SELECT writes FROM thread_write_probe`.pipe(
    Effect.map((rows) => rows[0]?.writes ?? 0),
  );

const triggerSql = (sql: SqlClient.SqlClient) =>
  sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'projection_turns_latest_completed_update'
  `.pipe(Effect.map((rows) => rows[0]?.sql ?? null));

describe("091 guarded latest-completed turn trigger", () => {
  it.effect("skips the recompute when a turn upsert changes no watched value", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* insertThread(sql, "t1");
      const completed = {
        threadId: "t1",
        turnId: "turn-1",
        state: "completed",
        requestedAt: "2026-10-01T00:00:01.000Z",
        completedAt: "2026-10-01T00:00:05.000Z",
      };
      yield* upsertTurn(sql, completed);
      assert.equal(yield* latestCompletedTurnAt(sql, "t1"), "2026-10-01T00:00:05.000Z");
      yield* installThreadWriteProbe(sql);

      // A streamed assistant delta re-upserts the turn with identical values.
      yield* upsertTurn(sql, completed);
      yield* upsertTurn(sql, completed);
      assert.equal(yield* threadWrites(sql), 0);

      // A real change still recomputes, once (the turn stayed on the same thread).
      yield* upsertTurn(sql, {
        ...completed,
        turnId: "turn-2",
        state: "running",
        requestedAt: "2026-10-01T00:01:00.000Z",
        completedAt: null,
      });
      const writesAfterInsert = yield* threadWrites(sql);
      yield* upsertTurn(sql, {
        ...completed,
        turnId: "turn-2",
        requestedAt: "2026-10-01T00:01:00.000Z",
        completedAt: "2026-10-01T00:02:00.000Z",
      });
      assert.equal((yield* threadWrites(sql)) - writesAfterInsert, 1);
      assert.equal(yield* latestCompletedTurnAt(sql, "t1"), "2026-10-01T00:02:00.000Z");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("recomputes both threads when a turn moves between threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* insertThread(sql, "a");
      yield* insertThread(sql, "b");
      yield* upsertTurn(sql, {
        threadId: "a",
        turnId: "turn-move",
        state: "completed",
        requestedAt: "2026-10-01T00:00:01.000Z",
        completedAt: "2026-10-01T00:00:05.000Z",
      });
      assert.equal(yield* latestCompletedTurnAt(sql, "a"), "2026-10-01T00:00:05.000Z");

      yield* sql`UPDATE projection_turns SET thread_id = 'b' WHERE turn_id = 'turn-move'`;
      assert.equal(yield* latestCompletedTurnAt(sql, "a"), null);
      assert.equal(yield* latestCompletedTurnAt(sql, "b"), "2026-10-01T00:00:05.000Z");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("replaces the unguarded 087 body once and survives the 087 repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });
      assert.notInclude(yield* triggerSql(sql), "WHEN");

      yield* runMigrations({ toMigrationInclusive: 91 });
      assert.include(yield* triggerSql(sql), "OLD.state IS NOT NEW.state");
      assert.isFalse(yield* ensureGuardedLatestCompletedTurnTrigger);

      // A dropped trigger is recreated unguarded by the 087 repair, then guarded again.
      yield* sql`DROP TRIGGER projection_turns_latest_completed_update`;
      yield* runMigrations();
      assert.include(yield* triggerSql(sql), "OLD.state IS NOT NEW.state");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
