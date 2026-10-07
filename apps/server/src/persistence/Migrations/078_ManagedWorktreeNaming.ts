import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Node-owned names and a durable, independently recoverable journal for each move. */
export const ensureManagedWorktreeNaming = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS managed_worktree_projects (
    project_id TEXT PRIMARY KEY, directory_name TEXT NOT NULL UNIQUE
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS managed_worktree_paths (
    path TEXT PRIMARY KEY, allocated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS managed_worktree_editor_pins (path TEXT PRIMARY KEY, created_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS managed_worktree_relocations (
    worktree_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    repository_path TEXT NOT NULL, source_path TEXT NOT NULL UNIQUE,
    destination_path TEXT NOT NULL UNIQUE, identity_json TEXT NOT NULL, destination_identity_json TEXT,
    expected_updated_at TEXT NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, last_error TEXT
  )`;
});
export default ensureManagedWorktreeNaming;
