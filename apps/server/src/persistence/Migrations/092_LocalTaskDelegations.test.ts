import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

/** A task row as migration 070's single-start service wrote it. */
const insertLegacyTask = (input: {
  readonly taskId: string;
  readonly deleted?: boolean;
  readonly start?: { readonly dispatched: boolean };
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const start = input.start;
    const taskJson = JSON.stringify({
      taskId: input.taskId,
      revision: 1,
      title: "Old task",
      notes: "",
      priority: "normal",
      dueAt: null,
      projectId: "project",
      state: "todo",
      status: "starting",
      delegation: start
        ? {
            threadId: "thread",
            messageId: `message-${input.taskId}`,
            commandId: `command-${input.taskId}`,
            dispatched: start.dispatched,
          }
        : null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:05:00.000Z",
    });
    yield* sql`INSERT INTO local_tasks (task_id, revision, task_json, create_digest, command_id,
        delegation_thread_id, delegation_message_id, command_json, command_digest, deleted_at)
      VALUES (${input.taskId}, 1, ${taskJson}, 'digest', ${start ? `command-${input.taskId}` : null},
        ${start ? "thread" : null}, ${start ? `message-${input.taskId}` : null},
        ${start ? '{"type":"thread.turn.start"}' : null}, ${start ? "command-digest" : null},
        ${input.deleted ? "2026-10-01T01:00:00.000Z" : null})`;
  });

const starts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly command_id: string;
    readonly task_id: string;
    readonly sequence: number;
    readonly dispatched: number;
    readonly file_ids_json: string;
    readonly branch: string | null;
    readonly created_at: string;
  }>`SELECT command_id, task_id, sequence, dispatched, file_ids_json, branch, created_at
    FROM local_task_delegations ORDER BY task_id`;
});

const hasTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_task_delegations'`;
  return rows.length === 1;
});

it.layer(NodeSqliteClient.layerMemory())("092 local task delegations", (it) => {
  it.effect("copies each live task's single start as its first chat, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      assert.isFalse(yield* hasTable);
      yield* insertLegacyTask({ taskId: "dispatched", start: { dispatched: true } });
      yield* insertLegacyTask({ taskId: "pending", start: { dispatched: false } });
      yield* insertLegacyTask({ taskId: "deleted", deleted: true, start: { dispatched: true } });
      yield* insertLegacyTask({ taskId: "never-started" });

      yield* runMigrations({ toMigrationInclusive: 92 });
      const expected = [
        {
          command_id: "command-dispatched",
          task_id: "dispatched",
          sequence: 1,
          dispatched: 1,
          file_ids_json: "[]",
          branch: null,
          created_at: "2026-10-01T00:05:00.000Z",
        },
        {
          command_id: "command-pending",
          task_id: "pending",
          sequence: 1,
          dispatched: 0,
          file_ids_json: "[]",
          branch: null,
          created_at: "2026-10-01T00:05:00.000Z",
        },
      ];
      assert.deepEqual(yield* starts, expected);

      // Re-running (the post-migrator repair) leaves the table and its rows alone.
      yield* sql`DELETE FROM local_task_delegations WHERE task_id = 'pending'`;
      yield* runMigrations();
      assert.deepEqual(yield* starts, expected.slice(0, 1));
      // The UNIQUE constraints' own indexes serve the per-task reads; no extra index is built.
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'local_task_delegations'
          AND sql IS NOT NULL`;
      assert.equal(indexes.length, 0);
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT * FROM local_task_delegations WHERE task_id = 'live'
          ORDER BY sequence`;
      assert.ok(plan.some((row) => row.detail.includes("USING INDEX")));
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("092 repair", (it) => {
  it.effect("creates and backfills the table when another branch recorded 092 first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* insertLegacyTask({ taskId: "dispatched", start: { dispatched: true } });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (92, CURRENT_TIMESTAMP, 'SomeOtherBranch')
      `;
      yield* runMigrations();
      assert.isTrue(yield* hasTable);
      assert.deepEqual(
        (yield* starts).map((row) => [row.command_id, row.sequence, row.dispatched]),
        [["command-dispatched", 1, 1]],
      );
    }),
  );
});
