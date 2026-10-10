/** Which document the pane edits: this checkout's or the whole project's. */
export type NotesPaneView = "worktree" | "project";

/**
 * Where a view's text stands: `saved` matches the node, `unsaved` waits for
 * the next autosave (or a retry), `saving` is on the wire.
 */
export type NotesSaveState = "saved" | "unsaved" | "saving";
