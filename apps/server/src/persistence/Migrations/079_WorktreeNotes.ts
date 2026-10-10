import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Server-owned worktree notes. `worktree_id` NULL is the project's main checkout.
 * No triggers or foreign keys: projections can be rebuilt, so the notes service
 * hides rows whose project or worktree is gone at read time instead.
 * Idempotent so it can also run as a repair when a later id was recorded first.
 */
export const ensureWorktreeNotesTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS worktree_notes (
    note_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('worktree', 'project')),
    body TEXT NOT NULL,
    thread_id TEXT NULL,
    revision INTEGER NOT NULL,
    create_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT NULL
  )`;
  // Covers the list's whole ORDER BY (note_id breaks ties), so it never sorts.
  yield* sql`DROP INDEX IF EXISTS worktree_notes_project_created`;
  yield* sql`CREATE INDEX IF NOT EXISTS worktree_notes_project_created_id
    ON worktree_notes(project_id, created_at DESC, note_id DESC) WHERE deleted_at IS NULL`;
});
export default ensureWorktreeNotesTable;
