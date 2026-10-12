import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

const COLUMNS = [
  // The last resolved `RepositoryIdentity` as JSON; NULL when the root is not a repository
  // (or was never resolved, see `repository_identity_checked_at`).
  "repository_identity_json",
  // Cheap revalidation key: the repository's git config location, size and mtime.
  "repository_identity_fingerprint",
  // When the identity was last resolved; NULL means never, so the next sweep resolves it.
  "repository_identity_checked_at",
] as const;

/**
 * Persisted repository identity per project, so shell snapshots and project lookups are pure SQL
 * and never wait on `git`. A background sync (see `project/repositoryIdentitySync.ts`) owns the
 * columns; projectors only clear them when a project's workspace root changes.
 *
 * No backfill: NULL `repository_identity_checked_at` makes the first sweep resolve every root.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or below
 * the latest applied one and parallel branches may claim the same id.
 */
export const ensureProjectionProjectRepositoryIdentityColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_projects'
  `;
  if (tables.length === 0) return false;
  const columns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`).map(
      (column) => column.name,
    ),
  );
  let added = false;
  for (const column of COLUMNS) {
    if (columns.has(column)) continue;
    yield* sql`ALTER TABLE projection_projects ADD COLUMN ${sql.literal(column)} TEXT`;
    added = true;
  }
  return added;
});

export default Effect.asVoid(ensureProjectionProjectRepositoryIdentityColumns);
