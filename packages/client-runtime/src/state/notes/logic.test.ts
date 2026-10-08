import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, WorktreeId, type WorktreeNote } from "@ryco/contracts";

import {
  applyPendingNoteChanges,
  noteSummaryText,
  noteWorktreeKey,
  parseNoteTodo,
  selectPinnedNotes,
  selectProjectNotes,
  selectWorktreeNotes,
  toggleNoteTodo,
  type PendingNoteChange,
} from "./logic.ts";

const PROJECT = ProjectId.make("project-1");
const FEATURE = WorktreeId.make("wt-feature");
const OTHER = WorktreeId.make("wt-other");

function note(
  noteId: string,
  overrides: Partial<WorktreeNote> & { minute?: number } = {},
): WorktreeNote {
  const { minute = 0, ...rest } = overrides;
  const at = new Date(Date.UTC(2026, 9, 7, 10, minute)).toISOString();
  return {
    noteId,
    revision: 0,
    projectId: PROJECT,
    worktreeId: FEATURE,
    scope: "worktree",
    body: noteId,
    threadId: ThreadId.make("thread-1"),
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}

const ids = (notes: ReadonlyArray<WorktreeNote>) => notes.map((entry) => entry.noteId);

describe("noteWorktreeKey", () => {
  it("keys the main checkout as null, like the node stores it", () => {
    expect(noteWorktreeKey({ worktreeId: null })).toBeNull();
    expect(noteWorktreeKey({ worktreeId: "wt-main", origin: "main" })).toBeNull();
    expect(noteWorktreeKey({ worktreeId: "wt-feature", origin: "branch" })).toBe(FEATURE);
    expect(noteWorktreeKey({ worktreeId: "wt-feature" })).toBe(FEATURE);
  });
});

describe("note selection", () => {
  const snapshot = {
    notes: [
      note("old-here", { minute: 1 }),
      note("pinned-elsewhere", { minute: 2, worktreeId: OTHER, scope: "project" }),
      note("other", { minute: 5, worktreeId: OTHER }),
      note("main", { minute: 4, worktreeId: null }),
      note("new-here", { minute: 3 }),
    ],
  };

  it("lists this worktree's notes and pinned notes, pinned first, then newest", () => {
    expect(ids(selectWorktreeNotes(snapshot, FEATURE))).toEqual([
      "pinned-elsewhere",
      "new-here",
      "old-here",
    ]);
    expect(ids(selectWorktreeNotes(snapshot, null))).toEqual(["pinned-elsewhere", "main"]);
  });

  it("lists every note newest first in the project view", () => {
    expect(ids(selectProjectNotes(snapshot))).toEqual([
      "other",
      "main",
      "new-here",
      "pinned-elsewhere",
      "old-here",
    ]);
    expect(ids(selectPinnedNotes(snapshot))).toEqual(["pinned-elsewhere"]);
    expect(selectWorktreeNotes(null, FEATURE)).toEqual([]);
  });

  it("breaks createdAt ties on the note id, descending", () => {
    expect(ids(selectProjectNotes({ notes: [note("a"), note("c"), note("b")] }))).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

describe("applyPendingNoteChanges", () => {
  it("lists unconfirmed creates as pending until the snapshot carries them", () => {
    const pending = new Map<string, PendingNoteChange>([
      ["draft", { kind: "create", note: note("draft", { minute: 9 }) }],
    ]);
    const before = applyPendingNoteChanges({ notes: [note("a")] }, pending);
    expect(before.map((entry) => [entry.noteId, entry.pending ?? false])).toEqual([
      ["a", false],
      ["draft", true],
    ]);

    const confirmed = applyPendingNoteChanges(
      { notes: [note("draft", { minute: 9, body: "server" }), note("a")] },
      pending,
    );
    expect(confirmed.map((entry) => [entry.noteId, entry.pending ?? false])).toEqual([
      ["draft", false],
      ["a", false],
    ]);
    expect(confirmed[0]!.body).toBe("server");
  });

  it("shows edits and hides deletes while they are in flight", () => {
    const pending = new Map<string, PendingNoteChange>([
      ["a", { kind: "update", body: "[x] done", scope: "project" }],
      ["b", { kind: "delete" }],
    ]);
    const listed = applyPendingNoteChanges({ notes: [note("a"), note("b")] }, pending);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ noteId: "a", body: "[x] done", scope: "project" });
  });
});

describe("todo bodies", () => {
  it("parses and toggles the todo prefix, keeping the rest verbatim", () => {
    expect(parseNoteTodo("[ ] ship it")).toEqual({ todo: "open", text: "ship it" });
    expect(parseNoteTodo("[X] shipped")).toEqual({ todo: "done", text: "shipped" });
    expect(parseNoteTodo("plain")).toEqual({ todo: null, text: "plain" });
    expect(toggleNoteTodo("[ ]  two spaces")).toBe("[x]  two spaces");
    expect(toggleNoteTodo("[x] done")).toBe("[ ] done");
    expect(toggleNoteTodo("plain")).toBe("plain");
  });

  it("summarises a body on one line", () => {
    expect(noteSummaryText("[ ] fix\n  the   build", 40)).toBe("fix the build");
    expect(noteSummaryText("abcdefghij", 5)).toBe("abcd…");
    // The ellipsis never follows a dangling space.
    expect(noteSummaryText("never cache notes", 13)).toBe("never cache…");
  });
});
