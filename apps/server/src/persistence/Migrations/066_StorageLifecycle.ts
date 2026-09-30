import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE storage_owned_entries (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, repository_path TEXT,
    project_id TEXT, category TEXT NOT NULL, identity_json TEXT NOT NULL,
    created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'owned',
    completed_at TEXT, last_error TEXT
  )`;
  yield* sql`CREATE INDEX storage_owned_entries_path_nocase ON storage_owned_entries(path COLLATE NOCASE)`;
  yield* sql`CREATE INDEX storage_pending_turns ON projection_turns(thread_id) WHERE state = 'pending'`;
  yield* sql`CREATE INDEX storage_owned_entries_state ON storage_owned_entries(state)`;
  yield* sql`CREATE TABLE storage_usage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sampled_at TEXT NOT NULL,
    project_id TEXT, measured_bytes INTEGER NOT NULL, incomplete_entries INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX storage_usage_history_project_time ON storage_usage_history(project_id, sampled_at)`;
  yield* sql`CREATE TABLE storage_cleanup_previews (
    token TEXT PRIMARY KEY, principal_key TEXT NOT NULL, expires_at TEXT NOT NULL,
    entries_json TEXT NOT NULL, policy_json TEXT NOT NULL, protected_paths_json TEXT NOT NULL, result_json TEXT,
    state TEXT NOT NULL DEFAULT 'preview'
  )`;
});
