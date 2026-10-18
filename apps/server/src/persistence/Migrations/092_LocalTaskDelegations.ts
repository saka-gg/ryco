import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per chat started from a local task, so a task can start any number of chats.
 *
 * Migration 070 kept a single start on the task row (`command_id`, `delegation_thread_id`,
 * `delegation_message_id`, `command_json`, `command_digest`, and `delegation` inside
 * `task_json`). Those starts are copied here as sequence 1. The old columns stay: dropping
 * columns that carry UNIQUE constraints needs a full table rebuild, and nothing writes or reads
 * them anymore.
 *
 * `command_json` is the start's exact turn-start command (JSON-encoded), `file_ids_json` the
 * task files the start carries, `failed_at`/`error` a start that failed before its chat could
 * run. Starting a chat never changes the task row.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id. The table and its
 * backfill commit together, so a present table means the backfill already ran. Returns whether
 * the table was missing.
 */
export const ensureLocalTaskDelegationsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_task_delegations'
      `;
      if (existing.length > 0) return false;
      yield* sql`CREATE TABLE local_task_delegations (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        branch TEXT,
        command_json TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        file_ids_json TEXT NOT NULL DEFAULT '[]',
        dispatched INTEGER NOT NULL DEFAULT 0,
        failed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, message_id),
        UNIQUE (task_id, sequence)
      )`;
      // `UNIQUE (task_id, sequence)` already indexes the per-task reads, so no extra index.
      // Only a live task's start is worth keeping. 070 starts never carried a bootstrap, so
      // they never asked for a worktree branch.
      yield* sql`INSERT OR IGNORE INTO local_task_delegations
        (command_id, task_id, sequence, thread_id, message_id, branch, command_json,
          command_digest, file_ids_json, dispatched, created_at)
        SELECT command_id, task_id, 1, delegation_thread_id, delegation_message_id, NULL,
          command_json, command_digest, '[]',
          CASE WHEN json_extract(task_json, '$.delegation.dispatched') THEN 1 ELSE 0 END,
          COALESCE(json_extract(task_json, '$.updatedAt'), '1970-01-01T00:00:00.000Z')
        FROM local_tasks
        WHERE deleted_at IS NULL AND command_id IS NOT NULL AND command_json IS NOT NULL
          AND command_digest IS NOT NULL AND delegation_thread_id IS NOT NULL
          AND delegation_message_id IS NOT NULL AND json_valid(task_json)`;
      return true;
    }),
  );
});

export default ensureLocalTaskDelegationsTable.pipe(Effect.asVoid);
