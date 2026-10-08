/** Which notes the pane lists: this worktree (plus pinned) or the whole project. */
export type NotesPaneView = "worktree" | "project";

/** Where a note lives: its worktree, or pinned to the whole project. */
export type NoteViewScope = "worktree" | "project";

/** A note as the NotesPane renders it; the data layer maps server notes into this. */
export interface NoteView {
  readonly id: string;
  /** Raw body; a leading `[ ]` / `[x]` makes it a todo (see noteText.logic). */
  readonly body: string;
  readonly scope: NoteViewScope;
  /** Set only when the note belongs to another worktree (a chip in the Project view). */
  readonly worktreeLabel: string | null;
  /** The thread it was written from; `title: null` means that thread was deleted. */
  readonly thread: { readonly id: string; readonly title: string | null } | null;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** Optimistic: saved locally, not yet confirmed by the server. */
  readonly pending?: boolean;
}

/** How a save from the composer ended; a rejected or refused body goes back to the composer. */
export type NoteSaveOutcome = "saved" | "unconfirmed" | "rejected" | "refused";
