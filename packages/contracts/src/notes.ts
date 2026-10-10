import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import { WorktreeId } from "./worktree.ts";

/** `worktree` belongs to one checkout; `project` is shared by the whole project. */
export const NoteScope = Schema.Literals(["worktree", "project"]);
export type NoteScope = typeof NoteScope.Type;
/** The longest notes document, in UTF-16 code units (what a textarea's `maxLength` counts). */
export const NOTE_BODY_MAX_LENGTH = 100_000;
/** Free text; empty is a cleared document. */
export const NoteBody = Schema.String.check(Schema.isMaxLength(NOTE_BODY_MAX_LENGTH));
export type NoteBody = typeof NoteBody.Type;

/**
 * One free-text notes document: a checkout's (`scope: "worktree"`, keyed by
 * its worktree, `null` for the main checkout) or the project's own
 * (`scope: "project"`, always `worktreeId: null`).
 */
export const NotesDocument = Schema.Struct({
  projectId: ProjectId,
  scope: NoteScope,
  worktreeId: Schema.NullOr(WorktreeId),
  body: NoteBody,
  /** Bumped by every save; a document never saved is revision 0 and is not listed. */
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type NotesDocument = typeof NotesDocument.Type;

export const NotesListInput = Schema.Struct({ projectId: ProjectId });
export type NotesListInput = typeof NotesListInput.Type;
export const NotesSnapshot = Schema.Struct({
  projectId: ProjectId,
  /** The project's document and every live checkout's, in no particular order. */
  documents: Schema.Array(NotesDocument),
});
export type NotesSnapshot = typeof NotesSnapshot.Type;

/** Replaces one document's body; judged against the revision the edit started from. */
export const NotesCommand = Schema.Struct({
  kind: Schema.Literal("save"),
  projectId: ProjectId,
  scope: NoteScope,
  /** Must be `null` for the project's document. */
  worktreeId: Schema.NullOr(WorktreeId),
  body: NoteBody,
  /** The revision the edit was based on (0 for a document never saved). */
  expectedRevision: NonNegativeInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type NotesCommand = typeof NotesCommand.Type;

export class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  reason: Schema.Literals(["conflict", "invalid", "persistence"]),
  message: Schema.String,
}) {}

/** Every command answers with the project's fresh snapshot. */
export interface NotesApi {
  readonly list: (input: NotesListInput) => Promise<NotesSnapshot>;
  readonly command: (input: NotesCommand) => Promise<NotesSnapshot>;
}
