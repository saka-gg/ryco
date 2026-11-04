import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The import jobs of cross-node project copies on this (destination) node.
 *
 * `input_json` is the job's full `projects.importStart` input and `input_digest` its digest, so
 * a retry with the same id is answered from the row and a different input is refused.
 * `snapshot_json` is the latest `ProjectImportSnapshot` subscribers see.
 *
 * `destination_key` is the destination's reservation key (the realpath of its nearest existing
 * ancestor joined with the remaining segments, case-folded on case-insensitive volumes): the
 * partial unique index keeps two running jobs off the same destination. `staging_path` is the
 * staging directory the job created, and `staging_dev` / `staging_ino` (decimal strings, so
 * 64-bit values survive) the identity that proves a later cleanup deletes that directory and
 * nothing the user put there since. `owned` is set once the job created it, `registered` once
 * it registered the project, after which nothing is ever deleted.
 *
 * `child_pid` / `child_pgid` / `child_started_at` name the child process a step is running, so
 * startup can signal a group that survived a crash, but only when its start time still matches.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id. The table and its
 * indexes commit together, so a present table means the indexes exist. Returns whether the
 * table was missing.
 */
export const ensureProjectImportsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_imports'
      `;
      if (existing.length > 0) return false;
      yield* sql`CREATE TABLE project_imports (
        import_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        destination_key TEXT NOT NULL,
        staging_path TEXT,
        staging_dev TEXT,
        staging_ino TEXT,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        child_pid INTEGER,
        child_pgid INTEGER,
        child_started_at TEXT,
        registered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
      // Startup recovery reads the running jobs; the list reads the newest few of a small table.
      yield* sql`CREATE INDEX idx_project_imports_status ON project_imports(status)`;
      yield* sql`CREATE UNIQUE INDEX idx_project_imports_running_destination
        ON project_imports(destination_key) WHERE status = 'running'`;
      return true;
    }),
  );
});

export default ensureProjectImportsTable.pipe(Effect.asVoid);
