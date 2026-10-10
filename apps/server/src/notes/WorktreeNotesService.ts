import {
  NotesCommand,
  NotesDocument,
  NotesError,
  NotesListInput,
  type NotesSnapshot,
  type ProjectId,
} from "@ryco/contracts";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type NotesEffect<A> = Effect.Effect<A, NotesError>;
export interface WorktreeNotesServiceShape {
  /** A live project's notes documents; documents of removed worktrees are hidden. */
  readonly list: (input: NotesListInput) => NotesEffect<NotesSnapshot>;
  /** Applies one command and answers with the project's fresh snapshot. */
  readonly command: (input: NotesCommand) => NotesEffect<NotesSnapshot>;
}
export class WorktreeNotesService extends Context.Service<
  WorktreeNotesService,
  WorktreeNotesServiceShape
>()("ryco/notes/WorktreeNotesService") {}

const error = (reason: NotesError["reason"], message: string) =>
  new NotesError({ reason, message });
const mapError = (cause: unknown) =>
  Schema.is(NotesError)(cause)
    ? cause
    : Schema.isSchemaError(cause)
      ? error("invalid", "Notes input is invalid.")
      : error("persistence", "Note storage is unavailable.");
const CHANGED = "Notes changed elsewhere.";

interface Row {
  project_id: string;
  scope: string;
  worktree_key: string;
  body: string;
  revision: number;
  updated_at: string;
}
const decodeDocument = Schema.decodeUnknownEffect(NotesDocument);
const present = (row: Row) =>
  decodeDocument({
    projectId: row.project_id,
    scope: row.scope,
    worktreeId: row.worktree_key === "" ? null : row.worktree_key,
    body: row.body,
    revision: row.revision,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError(() => error("persistence", "Note storage is unavailable.")));

export const makeWorktreeNotesService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
  const projectIsLive = (projectId: ProjectId) =>
    sql`SELECT 1 FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const worktreeFor = (worktreeId: string) =>
    sql<{
      project_id: string;
      origin: string;
    }>`SELECT project_id, origin FROM projection_worktrees WHERE worktree_id = ${worktreeId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );

  const listDocuments = (projectId: ProjectId) =>
    Effect.gen(function* () {
      // The project's and the main checkout's documents always show; a worktree's follows its projection row.
      const rows = yield* sql<Row>`SELECT d.* FROM notes_documents d
        WHERE d.project_id = ${projectId}
          AND EXISTS (SELECT 1 FROM projection_projects p WHERE p.project_id = d.project_id AND p.deleted_at IS NULL)
          AND (d.worktree_key = '' OR EXISTS (
            SELECT 1 FROM projection_worktrees w WHERE w.worktree_id = d.worktree_key AND w.project_id = d.project_id))
        ORDER BY d.scope, d.worktree_key`;
      const documents = yield* Effect.forEach(rows, present);
      return { projectId, documents } satisfies NotesSnapshot;
    });

  /** The document's storage key, or a failure when the command aims at nothing it may write. */
  const documentKey = (command: NotesCommand) =>
    Effect.gen(function* () {
      if (!(yield* projectIsLive(command.projectId)))
        return yield* Effect.fail(error("invalid", "The notes project is unavailable."));
      if (command.scope === "project") {
        if (command.worktreeId !== null)
          return yield* Effect.fail(error("invalid", "Project notes have no worktree."));
        return "";
      }
      if (command.worktreeId === null) return "";
      const worktree = yield* worktreeFor(command.worktreeId);
      if (!worktree || worktree.project_id !== command.projectId)
        return yield* Effect.fail(error("invalid", "The notes worktree is unavailable."));
      // The main checkout has one canonical key.
      return worktree.origin === "main" ? "" : command.worktreeId;
    });

  const save = (command: NotesCommand) =>
    Effect.gen(function* () {
      const key = yield* documentKey(command);
      const row = (yield* sql<Row>`SELECT * FROM notes_documents
        WHERE project_id = ${command.projectId} AND scope = ${command.scope} AND worktree_key = ${key}`)[0];
      const revision = row?.revision ?? 0;
      if (revision !== command.expectedRevision)
        return yield* Effect.fail(error("conflict", CHANGED));
      // A save that changes nothing keeps the revision, so it never conflicts other editors.
      if ((row?.body ?? "") === command.body) return;
      const at = yield* now;
      const written = yield* sql`INSERT INTO notes_documents
          (project_id, scope, worktree_key, body, revision, updated_at)
        VALUES (${command.projectId}, ${command.scope}, ${key}, ${command.body}, 1, ${at})
        ON CONFLICT (project_id, scope, worktree_key) DO UPDATE
          SET body = excluded.body, revision = notes_documents.revision + 1, updated_at = excluded.updated_at
          WHERE notes_documents.revision = ${revision}
        RETURNING revision`;
      if (written.length === 0) return yield* Effect.fail(error("conflict", CHANGED));
    });

  const service: WorktreeNotesServiceShape = {
    list: (input) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(NotesListInput)(input);
        return yield* listDocuments(decoded.projectId);
      }).pipe(Effect.mapError(mapError)),
    command: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(NotesCommand)(input);
            yield* save(decoded);
            return yield* listDocuments(decoded.projectId);
          }),
        )
        .pipe(Effect.mapError(mapError)),
  };
  return service;
});
export const WorktreeNotesServiceLive = Layer.effect(
  WorktreeNotesService,
  makeWorktreeNotesService,
);
