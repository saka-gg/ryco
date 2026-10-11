import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_worktrees (
      worktree_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      branch TEXT NOT NULL,
      worktree_path TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('main', 'branch', 'pr', 'issue', 'manual')),
      pr_number INTEGER,
      issue_number INTEGER,
      pr_title TEXT,
      issue_title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      manual_position INTEGER NOT NULL DEFAULT 0
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktrees_project_archived
    ON projection_worktrees(project_id, archived_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktrees_pr_lookup
    ON projection_worktrees(project_id, origin, pr_number)
    WHERE pr_number IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_worktrees_issue_lookup
    ON projection_worktrees(project_id, origin, issue_number)
    WHERE issue_number IS NOT NULL
  `;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN worktree_id TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN manual_status_bucket TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN manual_position INTEGER NOT NULL DEFAULT 0`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_worktree_bucket
    ON projection_threads(worktree_id, manual_status_bucket)
  `;
});
