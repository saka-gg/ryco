import type { NoteScope, NotesDocument } from "@ryco/contracts";
import { NOTE_BODY_MAX_LENGTH } from "@ryco/contracts/notes";

/**
 * The phone's notes editor, without React. Notes are free text per checkout
 * (`worktree`) and per project; the node judges each save against the
 * revision the edit started from, so text typed here is never lost to a save
 * made elsewhere meanwhile.
 */

export type NotesSaveStatus = "saved" | "unsaved" | "saving" | "tooLong" | "conflict";

export interface NotesEditorState {
  /** What the field shows: this device's unsaved text, else the node's document. */
  readonly body: string;
  /** The node's revision the shown text is based on (0: never saved). */
  readonly baseRevision: number;
  readonly status: NotesSaveStatus;
}

/** The node's document for a view, as the editor starts from it. */
export function notesEditorState(
  document: Pick<NotesDocument, "body" | "revision"> | null,
  draft: { readonly body: string; readonly baseRevision: number } | null,
  saving: boolean,
): NotesEditorState {
  const nodeBody = document ? document.body : "";
  const nodeRevision = document ? document.revision : 0;
  if (!draft || (draft.body === nodeBody && !saving))
    return { body: nodeBody, baseRevision: nodeRevision, status: saving ? "saving" : "saved" };
  if (draft.body.length > NOTE_BODY_MAX_LENGTH)
    return { body: draft.body, baseRevision: draft.baseRevision, status: "tooLong" };
  return {
    body: draft.body,
    baseRevision: draft.baseRevision,
    status: saving ? "saving" : draft.baseRevision !== nodeRevision ? "conflict" : "unsaved",
  };
}

export function notesStatusLabel(status: NotesSaveStatus): string {
  switch (status) {
    case "saved":
      return "Saved";
    case "unsaved":
      return "Not saved yet";
    case "saving":
      return "Saving…";
    case "tooLong":
      return `Too long (${NOTE_BODY_MAX_LENGTH.toLocaleString("en-US")} characters max)`;
    case "conflict":
      return "Changed elsewhere — saving keeps your text";
  }
}

export interface NotesScopeOption {
  readonly value: NoteScope;
  readonly label: string;
}

/** The scope switch: the checkout's notes and the project's. */
export function notesScopeOptions(worktreeLabel: string | null): NotesScopeOption[] {
  return [
    { value: "worktree", label: worktreeLabel ?? "Main checkout" },
    { value: "project", label: "Project" },
  ];
}

/**
 * The scopes whose typed text the node does not hold yet, project last, for
 * the prompt on leaving the screen.
 */
export function unsavedNoteScopes(
  drafts: Partial<Record<NoteScope, { readonly body: string; readonly baseRevision: number }>>,
  documentOf: (scope: NoteScope) => Pick<NotesDocument, "body" | "revision"> | null,
): NoteScope[] {
  return (["worktree", "project"] as const).filter((scope) => {
    const draft = drafts[scope];
    return (
      draft !== undefined && notesEditorState(documentOf(scope), draft, false).status !== "saved"
    );
  });
}
