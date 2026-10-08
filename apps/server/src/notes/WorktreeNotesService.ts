import { createHash } from "node:crypto";
import {
  NotesCommand,
  NotesError,
  NotesListInput,
  WorktreeNote,
  type NotesSnapshot,
  type ProjectId,
} from "@ryco/contracts";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Bounded view: the newest notes of one project. */
export const WORKTREE_NOTES_LIST_LIMIT = 500;

type NotesEffect<A> = Effect.Effect<A, NotesError>;
export interface WorktreeNotesServiceShape {
  /** Live notes of a live project, newest first; notes of removed worktrees are hidden. */
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
      ? error("invalid", "Note input is invalid.")
      : error("persistence", "Note storage is unavailable.");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CHANGED = "Note changed. Reload before editing.";
const MISSING = "Note not found.";

interface Row {
  note_id: string;
  project_id: string;
  worktree_id: string | null;
  scope: string;
  body: string;
  thread_id: string | null;
  revision: number;
  create_digest: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
const decodeNote = Schema.decodeUnknownEffect(WorktreeNote);
const present = (row: Row) =>
  decodeNote({
    noteId: row.note_id,
    revision: row.revision,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    scope: row.scope,
    body: row.body,
    threadId: row.thread_id,
    createdAt: row.created_at,
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
  const trimmedBody = (body: string) => {
    const trimmed = body.trim();
    return trimmed ? Effect.succeed(trimmed) : Effect.fail(error("invalid", "Note is empty."));
  };

  const listNotes = (projectId: ProjectId) =>
    Effect.gen(function* () {
      // Pinned and main-checkout notes always show; a worktree's notes follow its projection row.
      const rows = yield* sql<Row>`SELECT n.* FROM worktree_notes n
        WHERE n.project_id = ${projectId} AND n.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM projection_projects p WHERE p.project_id = n.project_id AND p.deleted_at IS NULL)
          AND (n.scope = 'project' OR n.worktree_id IS NULL OR EXISTS (
            SELECT 1 FROM projection_worktrees w WHERE w.worktree_id = n.worktree_id AND w.project_id = n.project_id))
        ORDER BY n.created_at DESC, n.note_id DESC
        LIMIT ${WORKTREE_NOTES_LIST_LIMIT + 1}`;
      const notes = yield* Effect.forEach(rows.slice(0, WORKTREE_NOTES_LIST_LIMIT), present);
      return {
        projectId,
        notes,
        limit: WORKTREE_NOTES_LIST_LIMIT,
        truncated: rows.length > WORKTREE_NOTES_LIST_LIMIT,
      } satisfies NotesSnapshot;
    });

  /** A live note of a live project, at the revision the client last saw. */
  const editableRow = (input: { noteId: string; projectId: ProjectId; expectedRevision: number }) =>
    Effect.gen(function* () {
      const row =
        (yield* sql<Row>`SELECT * FROM worktree_notes WHERE note_id = ${input.noteId}`)[0];
      if (!row || row.deleted_at !== null || row.project_id !== input.projectId)
        return yield* Effect.fail(error("not-found", MISSING));
      if (!(yield* projectIsLive(input.projectId)))
        return yield* Effect.fail(error("not-found", MISSING));
      if (row.revision !== input.expectedRevision)
        return yield* Effect.fail(error("conflict", CHANGED));
      return row;
    });
  const requireChanged = (rows: ReadonlyArray<unknown>) =>
    rows.length ? Effect.void : Effect.fail(error("conflict", CHANGED));

  const create = (command: Extract<NotesCommand, { kind: "create" }>) =>
    Effect.gen(function* () {
      const body = yield* trimmedBody(command.body);
      const existing =
        (yield* sql<Row>`SELECT * FROM worktree_notes WHERE note_id = ${command.noteId}`)[0];
      if (existing) {
        // A tombstone keeps a retried create from resurrecting a deleted note.
        if (existing.deleted_at !== null || existing.create_digest !== digest(command))
          return yield* Effect.fail(error("conflict", "Note identifier is already in use."));
        return;
      }
      if (!(yield* projectIsLive(command.projectId)))
        return yield* Effect.fail(error("invalid", "The note project is unavailable."));
      let worktreeId: string | null = null;
      if (command.worktreeId !== null) {
        const worktree = yield* worktreeFor(command.worktreeId);
        if (!worktree || worktree.project_id !== command.projectId)
          return yield* Effect.fail(error("invalid", "The note worktree is unavailable."));
        // The main checkout has one canonical key.
        worktreeId = worktree.origin === "main" ? null : command.worktreeId;
      }
      // The thread is a soft backlink: keep it only while it belongs to this project.
      const threadId =
        command.threadId === null
          ? null
          : (yield* sql`SELECT 1 FROM projection_threads
              WHERE thread_id = ${command.threadId} AND project_id = ${command.projectId} AND deleted_at IS NULL`)
                .length
            ? command.threadId
            : null;
      const at = yield* now;
      yield* sql`INSERT INTO worktree_notes (note_id, project_id, worktree_id, scope, body, thread_id,
        revision, create_digest, created_at, updated_at, deleted_at)
        VALUES (${command.noteId}, ${command.projectId}, ${worktreeId}, ${command.scope}, ${body}, ${threadId},
        0, ${digest(command)}, ${at}, ${at}, NULL)`;
    });

  const update = (command: Extract<NotesCommand, { kind: "update" }>) =>
    Effect.gen(function* () {
      if (command.body === undefined && command.scope === undefined)
        return yield* Effect.fail(error("invalid", "Nothing to change."));
      const row = yield* editableRow(command);
      const body = command.body === undefined ? row.body : yield* trimmedBody(command.body);
      const scope = command.scope ?? row.scope;
      // An edit that changes nothing keeps the revision, so it never conflicts other editors.
      if (body === row.body && scope === row.scope) return;
      if (scope === "worktree" && row.scope !== "worktree" && row.worktree_id !== null) {
        const worktree = yield* worktreeFor(row.worktree_id);
        // Unpinning would hide the note along with its removed worktree.
        if (!worktree || worktree.project_id !== row.project_id)
          return yield* Effect.fail(
            error(
              "invalid",
              "The note's worktree no longer exists. Keep it pinned to the project.",
            ),
          );
      }
      const at = yield* now;
      yield* requireChanged(
        yield* sql`UPDATE worktree_notes SET body = ${body}, scope = ${scope},
          revision = revision + 1, updated_at = ${at}
          WHERE note_id = ${row.note_id} AND revision = ${row.revision} AND deleted_at IS NULL
          RETURNING note_id`,
      );
    });

  const remove = (command: Extract<NotesCommand, { kind: "delete" }>) =>
    Effect.gen(function* () {
      const row = yield* editableRow(command);
      const at = yield* now;
      yield* requireChanged(
        yield* sql`UPDATE worktree_notes SET deleted_at = ${at}, updated_at = ${at},
          revision = revision + 1, body = ''
          WHERE note_id = ${row.note_id} AND revision = ${row.revision} AND deleted_at IS NULL
          RETURNING note_id`,
      );
    });

  const service: WorktreeNotesServiceShape = {
    list: (input) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(NotesListInput)(input);
        return yield* listNotes(decoded.projectId);
      }).pipe(Effect.mapError(mapError)),
    command: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(NotesCommand)(input);
            switch (decoded.kind) {
              case "create":
                yield* create(decoded);
                break;
              case "update":
                yield* update(decoded);
                break;
              case "delete":
                yield* remove(decoded);
                break;
            }
            return yield* listNotes(decoded.projectId);
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
