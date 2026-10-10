import { describe, expect, it } from "vite-plus/test";
import { ProjectId, WorktreeId, type NotesDocument } from "@ryco/contracts";

import { notesDocumentKey, noteWorktreeKey, selectNotesDocument } from "./logic.ts";

const PROJECT = ProjectId.make("project");
const FEATURE = WorktreeId.make("feature");

const document = (overrides: Partial<NotesDocument>): NotesDocument => ({
  projectId: PROJECT,
  scope: "worktree",
  worktreeId: null,
  body: "Body",
  revision: 1,
  updatedAt: "2026-10-07T00:00:00.000Z",
  ...overrides,
});

describe("noteWorktreeKey", () => {
  it("keys the main checkout as null, however it is named", () => {
    expect(noteWorktreeKey({ worktreeId: null })).toBeNull();
    expect(noteWorktreeKey({ worktreeId: "main-row", origin: "main" })).toBeNull();
    expect(noteWorktreeKey({ worktreeId: "feature", origin: "branch" })).toBe("feature");
  });
});

describe("notesDocumentKey", () => {
  it("separates the project's document from every checkout's", () => {
    const keys = new Set([
      notesDocumentKey("project", null),
      notesDocumentKey("worktree", null),
      notesDocumentKey("worktree", FEATURE),
    ]);
    expect(keys.size).toBe(3);
    // A project document never carries a worktree.
    expect(notesDocumentKey("project", FEATURE)).toBe(notesDocumentKey("project", null));
  });
});

describe("selectNotesDocument", () => {
  it("finds a document by scope and checkout", () => {
    const project = document({ scope: "project", body: "Project" });
    const main = document({ body: "Main" });
    const feature = document({ worktreeId: FEATURE, body: "Feature" });
    const snapshot = { documents: [feature, project, main] };
    expect(selectNotesDocument(snapshot, "project", null)).toBe(project);
    expect(selectNotesDocument(snapshot, "worktree", null)).toBe(main);
    expect(selectNotesDocument(snapshot, "worktree", FEATURE)).toBe(feature);
    expect(selectNotesDocument(snapshot, "worktree", WorktreeId.make("other"))).toBeNull();
    expect(selectNotesDocument(null, "project", null)).toBeNull();
  });
});
