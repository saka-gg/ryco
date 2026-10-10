import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The longest document body (contracts' `NOTE_BODY_MAX_LENGTH` when this shipped). */
const BODY_MAX_LENGTH = 100_000;

/**
 * Server-owned notes documents: one free-text body per checkout
 * (`scope = 'worktree'`) and one per project (`scope = 'project'`).
 * `worktree_key` is the worktree id, or '' for the main checkout and the
 * project's own document (a primary key column cannot hold NULL twice).
 * No foreign keys: projections can be rebuilt, so the notes service hides
 * documents whose project or worktree is gone at read time instead.
 * Idempotent so it can also run as a repair when a later id was recorded first.
 */
export const ensureNotesDocumentsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS notes_documents (
    project_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('worktree', 'project')),
    worktree_key TEXT NOT NULL CHECK (scope = 'worktree' OR worktree_key = ''),
    body TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, scope, worktree_key)
  ) WITHOUT ROWID`;
});

interface LegacyNote {
  readonly project_id: string;
  readonly worktree_id: string | null;
  readonly scope: string;
  readonly body: string;
  readonly updated_at: string;
}

/**
 * Folds the 079 per-entry notes into documents, oldest first, one blank line
 * apart: pinned notes into the project's document, the rest into their
 * checkout's. Never overwrites a document; the legacy table is left as is.
 */
const foldLegacyNotes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacy = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worktree_notes'`;
  if (legacy.length === 0) return;
  const notes = yield* sql<LegacyNote>`
    SELECT project_id, worktree_id, scope, body, updated_at FROM worktree_notes
    WHERE deleted_at IS NULL ORDER BY created_at ASC, note_id ASC`;
  const documents = new Map<
    string,
    { project: string; scope: string; key: string; bodies: string[]; updatedAt: string }
  >();
  for (const note of notes) {
    const scope = note.scope === "project" ? "project" : "worktree";
    const key = scope === "project" ? "" : (note.worktree_id ?? "");
    const id = JSON.stringify([note.project_id, scope, key]);
    const document = documents.get(id) ?? {
      project: note.project_id,
      scope,
      key,
      bodies: [],
      updatedAt: note.updated_at,
    };
    document.bodies.push(note.body);
    if (note.updated_at > document.updatedAt) document.updatedAt = note.updated_at;
    documents.set(id, document);
  }
  for (const document of documents.values()) {
    const body = document.bodies.join("\n\n").slice(0, BODY_MAX_LENGTH);
    yield* sql`INSERT OR IGNORE INTO notes_documents
      (project_id, scope, worktree_key, body, revision, updated_at)
      VALUES (${document.project}, ${document.scope}, ${document.key}, ${body}, 1, ${document.updatedAt})`;
  }
});

export default Effect.gen(function* () {
  yield* ensureNotesDocumentsTable;
  yield* foldLegacyNotes;
});
