import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Recoverable Trash for conversations and retained workspace records after checkout
 * removal. No backfill: rows deleted before this migration lost their attachments and
 * terminal history, so they stay permanently deleted (`trashed_at` NULL) rather than
 * being presented as recoverable.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at
 * or below the latest applied one and parallel branches may claim the same id.
 */
export const ensureThreadWorkspaceLifecycleColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('projection_threads', 'projection_worktrees')
  `;
  let added = false;
  if (tables.some((table) => table.name === "projection_threads")) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    if (!columns.some((column) => column.name === "trashed_at")) {
      yield* sql`ALTER TABLE projection_threads ADD COLUMN trashed_at TEXT`;
      added = true;
    }
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_threads_trashed
      ON projection_threads(trashed_at) WHERE trashed_at IS NOT NULL
    `;
  }
  if (tables.some((table) => table.name === "projection_worktrees")) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_worktrees)`;
    if (!columns.some((column) => column.name === "checkout_removed_at")) {
      yield* sql`ALTER TABLE projection_worktrees ADD COLUMN checkout_removed_at TEXT`;
      added = true;
    }
    if (!columns.some((column) => column.name === "checkout_removal_reason")) {
      yield* sql`ALTER TABLE projection_worktrees ADD COLUMN checkout_removal_reason TEXT`;
      added = true;
    }
  }
  return added;
});

export default Effect.asVoid(ensureThreadWorkspaceLifecycleColumns);
