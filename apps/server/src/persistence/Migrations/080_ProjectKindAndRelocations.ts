import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Project kinds ("No project" chats are projects of kind `chat`) and the crash-safe journal for
 * moving a chat folder when it is promoted, with the title the promotion asked for so recovery can
 * apply it. Existing rows are regular projects.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id.
 */
export const ensureProjectKindAndRelocations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let added = false;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_projects'
  `;
  if (tables.length > 0) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
    if (!columns.some((column) => column.name === "kind")) {
      yield* sql`ALTER TABLE projection_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'`;
      added = true;
    }
  }
  const journals = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'project_relocations'
  `;
  if (journals.length === 0) {
    yield* sql`CREATE TABLE project_relocations (
      relocation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK (strategy IN ('rename', 'copy')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'moved', 'done', 'failed')),
      destination_created INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    added = true;
  } else {
    // A journal created before the requested title was recorded.
    const journalColumns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(project_relocations)`;
    if (!journalColumns.some((column) => column.name === "title")) {
      yield* sql`ALTER TABLE project_relocations ADD COLUMN title TEXT`;
      added = true;
    }
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_relocations_state
    ON project_relocations(state)
  `;
  return added;
});

export default Effect.asVoid(ensureProjectKindAndRelocations);
