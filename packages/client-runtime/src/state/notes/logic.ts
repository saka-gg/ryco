import type {
  NoteScope,
  NotesDocument,
  NotesSnapshot,
  WorktreeId,
  WorktreeOrigin,
} from "@ryco/contracts";

/**
 * Pure rules of notes documents shared by every client: which checkout a
 * document belongs to, how documents are keyed, and finding one in the
 * node's snapshot.
 */

/** The checkout a thread runs in, as the notes key it. */
export interface NotesCheckout {
  /** `null` is the project's main checkout. */
  readonly worktreeId: string | null;
  /** A worktree row whose origin is `main` is the main checkout too. */
  readonly origin?: WorktreeOrigin | null | undefined;
}

/**
 * The key a checkout's document is stored under: the worktree id, or `null`
 * for the main checkout. Mirrors the node, which stores a save aimed at the
 * main worktree row under `null`.
 */
export function noteWorktreeKey(checkout: NotesCheckout): WorktreeId | null {
  if (checkout.worktreeId === null || checkout.origin === "main") return null;
  return checkout.worktreeId as WorktreeId;
}

/** Identifies one document within a project; the project's own document has no worktree. */
export function notesDocumentKey(scope: NoteScope, worktreeId: WorktreeId | null): string {
  return scope === "project" ? "project" : `worktree:${worktreeId ?? ""}`;
}

/** The listed document, or null when it was never saved (or its worktree is gone). */
export function selectNotesDocument(
  snapshot: Pick<NotesSnapshot, "documents"> | null | undefined,
  scope: NoteScope,
  worktreeId: WorktreeId | null,
): NotesDocument | null {
  const key = notesDocumentKey(scope, worktreeId);
  return (
    snapshot?.documents.find(
      (document) => notesDocumentKey(document.scope, document.worktreeId) === key,
    ) ?? null
  );
}
