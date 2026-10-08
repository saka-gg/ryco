import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { WorktreeId } from "./worktree.ts";

/** Client-generated, so a retried create is idempotent. */
export const WorktreeNoteId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export type WorktreeNoteId = typeof WorktreeNoteId.Type;
/** `worktree` belongs to one checkout; `project` is pinned across the whole project. */
export const NoteScope = Schema.Literals(["worktree", "project"]);
export type NoteScope = typeof NoteScope.Type;
/** The longest note body, in UTF-16 code units (what a textarea's `maxLength` counts). */
export const NOTE_BODY_MAX_LENGTH = 10_000;
/** The node trims bodies and rejects blank ones. */
export const NoteBody = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(NOTE_BODY_MAX_LENGTH),
);
export type NoteBody = typeof NoteBody.Type;

export const WorktreeNote = Schema.Struct({
  noteId: WorktreeNoteId,
  revision: NonNegativeInt,
  projectId: ProjectId,
  /** `null` is the project's main checkout. */
  worktreeId: Schema.NullOr(WorktreeId),
  scope: NoteScope,
  body: NoteBody,
  /** Soft backlink to the thread the note was written from. */
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorktreeNote = typeof WorktreeNote.Type;

export const NotesListInput = Schema.Struct({ projectId: ProjectId });
export type NotesListInput = typeof NotesListInput.Type;
export const NotesSnapshot = Schema.Struct({
  projectId: ProjectId,
  /** Newest first. */
  notes: Schema.Array(WorktreeNote),
  limit: PositiveInt,
  /** More notes exist than this bounded view returns. */
  truncated: Schema.Boolean,
});
export type NotesSnapshot = typeof NotesSnapshot.Type;

export const NotesCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    noteId: WorktreeNoteId,
    projectId: ProjectId,
    worktreeId: Schema.NullOr(WorktreeId),
    scope: NoteScope,
    body: NoteBody,
    threadId: Schema.NullOr(ThreadId),
  }),
  Schema.Struct({
    kind: Schema.Literal("update"),
    noteId: WorktreeNoteId,
    projectId: ProjectId,
    expectedRevision: NonNegativeInt,
    body: Schema.optionalKey(NoteBody),
    scope: Schema.optionalKey(NoteScope),
  }),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    noteId: WorktreeNoteId,
    projectId: ProjectId,
    expectedRevision: NonNegativeInt,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type NotesCommand = typeof NotesCommand.Type;

export class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  reason: Schema.Literals(["not-found", "conflict", "invalid", "persistence"]),
  message: Schema.String,
}) {}

/** Every command answers with the project's fresh snapshot. */
export interface NotesApi {
  readonly list: (input: NotesListInput) => Promise<NotesSnapshot>;
  readonly command: (input: NotesCommand) => Promise<NotesSnapshot>;
}
