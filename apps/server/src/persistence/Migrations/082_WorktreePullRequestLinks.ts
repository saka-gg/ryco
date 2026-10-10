import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Every pull request a workspace has carried, as JSON (`WorktreePullRequestLink[]`).
 * No backfill: NULL means "derive one link from the flat `pr_*` columns", which
 * is exactly what a row written before links existed holds.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at
 * or below the latest applied one and parallel branches may claim the same id.
 */
export const ensureWorktreePullRequestLinksColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_worktrees'
  `;
  if (tables.length === 0) return false;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_worktrees)`;
  if (columns.some((column) => column.name === "pull_requests_json")) return false;
  yield* sql`ALTER TABLE projection_worktrees ADD COLUMN pull_requests_json TEXT`;
  return true;
});

export default Effect.asVoid(ensureWorktreePullRequestLinksColumn);
