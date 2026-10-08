import type {
  NoteScope,
  NotesSnapshot,
  WorktreeId,
  WorktreeNote,
  WorktreeOrigin,
} from "@ryco/contracts";

/**
 * Pure rules of worktree notes shared by every client: which checkout a note
 * belongs to, what each pane lists and in what order, optimistic changes laid
 * over the server's snapshot, and the plain-text todo convention of a body.
 */

/** The checkout a thread runs in, as the notes key it. */
export interface NotesCheckout {
  /** `null` is the project's main checkout. */
  readonly worktreeId: string | null;
  /** A worktree row whose origin is `main` is the main checkout too. */
  readonly origin?: WorktreeOrigin | null | undefined;
}

/**
 * The key notes are stored under for a checkout: the worktree id, or `null`
 * for the main checkout. Mirrors the node, which stores a create aimed at the
 * main worktree row under `null`.
 */
export function noteWorktreeKey(checkout: NotesCheckout): WorktreeId | null {
  if (checkout.worktreeId === null || checkout.origin === "main") return null;
  return checkout.worktreeId as WorktreeId;
}

/** A note as a pane lists it; `pending` marks an optimistic create the node has not confirmed. */
export type ListedNote = WorktreeNote & { readonly pending?: true };

/** Newest first; ties break like the node's list (`note_id DESC`). */
export function compareNotesNewestFirst(left: WorktreeNote, right: WorktreeNote): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  if (left.noteId === right.noteId) return 0;
  return left.noteId < right.noteId ? 1 : -1;
}

function pinnedFirst(left: WorktreeNote, right: WorktreeNote): number {
  const pinned = Number(right.scope === "project") - Number(left.scope === "project");
  return pinned || compareNotesNewestFirst(left, right);
}

/**
 * The Worktree view: this checkout's notes plus every note pinned to the
 * project, pinned first, then newest.
 */
export function selectWorktreeNotes<T extends WorktreeNote>(
  snapshot: { readonly notes: ReadonlyArray<T> } | null | undefined,
  worktreeKey: WorktreeId | null,
): T[] {
  return (snapshot?.notes ?? [])
    .filter((note) => note.scope === "project" || note.worktreeId === worktreeKey)
    .toSorted(pinnedFirst);
}

/** Only the notes pinned to the project, newest first (a draft has no checkout yet). */
export function selectPinnedNotes<T extends WorktreeNote>(
  snapshot: { readonly notes: ReadonlyArray<T> } | null | undefined,
): T[] {
  return (snapshot?.notes ?? [])
    .filter((note) => note.scope === "project")
    .toSorted(compareNotesNewestFirst);
}

/** The Project view: every note of every worktree, newest first. */
export function selectProjectNotes<T extends WorktreeNote>(
  snapshot: { readonly notes: ReadonlyArray<T> } | null | undefined,
): T[] {
  return (snapshot?.notes ?? []).toSorted(compareNotesNewestFirst);
}

/** A command sent but not yet answered, shown ahead of the node's snapshot. */
export type PendingNoteChange =
  | { readonly kind: "create"; readonly note: WorktreeNote }
  | { readonly kind: "update"; readonly body?: string; readonly scope?: NoteScope }
  | { readonly kind: "delete" };

/**
 * The snapshot with unanswered commands applied: an unconfirmed create is
 * listed as pending until the snapshot carries its id, an edit shows its new
 * body / scope, and a delete hides its note.
 */
export function applyPendingNoteChanges(
  snapshot: Pick<NotesSnapshot, "notes"> | null | undefined,
  pending: ReadonlyMap<string, PendingNoteChange>,
): ListedNote[] {
  const notes = snapshot?.notes ?? [];
  if (pending.size === 0) return [...notes];
  const listed: ListedNote[] = [];
  const present = new Set<string>();
  for (const note of notes) {
    present.add(note.noteId);
    const change = pending.get(note.noteId);
    if (change?.kind === "delete") continue;
    if (change?.kind === "update") {
      listed.push({
        ...note,
        ...(change.body !== undefined ? { body: change.body } : {}),
        ...(change.scope !== undefined ? { scope: change.scope } : {}),
      });
      continue;
    }
    listed.push(note);
  }
  for (const [noteId, change] of pending) {
    if (change.kind === "create" && !present.has(noteId))
      listed.push({ ...change.note, pending: true });
  }
  return listed;
}

const TODO_PREFIX = /^\[( |x|X)\]\s*/;

export type NoteTodoState = "open" | "done";

export interface ParsedNoteTodo {
  readonly todo: NoteTodoState | null;
  /** The body without its todo prefix. */
  readonly text: string;
}

/** A leading `[ ]` / `[x]` makes a note a todo (prototype `stripTodo`). */
export function parseNoteTodo(body: string): ParsedNoteTodo {
  const match = TODO_PREFIX.exec(body);
  if (!match) return { todo: null, text: body };
  return { todo: match[1] === " " ? "open" : "done", text: body.slice(match[0].length) };
}

/** Flips `[ ]` ↔ `[x]`, keeping the rest of the body byte-for-byte. Non-todos are returned as is. */
export function toggleNoteTodo(body: string): string {
  const match = TODO_PREFIX.exec(body);
  if (!match) return body;
  return `${match[1] === " " ? "[x]" : "[ ]"}${body.slice(3)}`;
}

/** One-line summary (alerts, titles): todo prefix stripped, whitespace collapsed, ellipsised past `max`. */
export function noteSummaryText(body: string, max: number): string {
  const text = parseNoteTodo(body.trim()).text.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
