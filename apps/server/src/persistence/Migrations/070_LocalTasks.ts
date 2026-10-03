import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE local_tasks (
    task_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    task_json TEXT NOT NULL,
    create_digest TEXT NOT NULL,
    command_id TEXT UNIQUE,
    delegation_thread_id TEXT,
    delegation_message_id TEXT,
    command_json TEXT,
    command_digest TEXT,
    deleted_at TEXT,
    UNIQUE (delegation_thread_id, delegation_message_id)
  )`;
  yield* sql`CREATE INDEX local_tasks_visible ON local_tasks(task_id) WHERE deleted_at IS NULL`;
  yield* sql`CREATE INDEX projection_turns_user_message ON projection_turns(thread_id, pending_message_id, row_id DESC) WHERE pending_message_id IS NOT NULL`;
  yield* sql`CREATE INDEX local_task_start_failures ON projection_thread_activities(thread_id, json_extract(payload_json, '$.messageId'))
    WHERE kind = 'provider.turn.start.failed' AND json_valid(payload_json)`;
});
