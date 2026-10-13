import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One-time lifecycle transitions the server records once they are done.
 *
 * `trash_retired_at` marks when the Trash page was retired: conversations that were in Trash
 * then were moved to Archive, and only threads trashed after it are deleted permanently once
 * their undo grace period passes (`ThreadPurgeReactor`).
 *
 * Idempotent: it also runs as a post-migrator repair when another branch recorded id 089 first.
 * Returns whether the table had to be created.
 */
export const ensureLifecycleMarkersTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_markers'
  `;
  if (existing.length > 0) return false;
  yield* sql`
    CREATE TABLE IF NOT EXISTS lifecycle_markers (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  return true;
});

export default Effect.asVoid(ensureLifecycleMarkersTable);
