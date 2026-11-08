import { describe, expect, it } from "vite-plus/test";

import { NOTE_BODY_MAX_LENGTH } from "@ryco/contracts/notes";

import {
  notesEditorState,
  notesScopeOptions,
  notesStatusLabel,
  unsavedNoteScopes,
} from "./notesModel";

describe("notes editor", () => {
  it("shows the node's document when nothing is typed", () => {
    expect(notesEditorState({ body: "hi", revision: 3 }, null, false)).toEqual({
      body: "hi",
      baseRevision: 3,
      status: "saved",
    });
    expect(notesEditorState(null, null, false)).toEqual({
      body: "",
      baseRevision: 0,
      status: "saved",
    });
  });

  it("keeps typed text and says whether it is saved", () => {
    const doc = { body: "a", revision: 2 };
    expect(notesEditorState(doc, { body: "ab", baseRevision: 2 }, false).status).toBe("unsaved");
    expect(notesEditorState(doc, { body: "ab", baseRevision: 2 }, true).status).toBe("saving");
    expect(notesEditorState(doc, { body: "a", baseRevision: 2 }, false).status).toBe("saved");
  });

  it("flags a document saved elsewhere since the edit started", () => {
    const state = notesEditorState(
      { body: "x", revision: 5 },
      { body: "mine", baseRevision: 4 },
      false,
    );
    expect(state).toEqual({ body: "mine", baseRevision: 4, status: "conflict" });
    expect(notesStatusLabel(state.status)).toContain("Changed elsewhere");
  });

  it("refuses text over the limit", () => {
    const long = "x".repeat(NOTE_BODY_MAX_LENGTH + 1);
    expect(notesEditorState(null, { body: long, baseRevision: 0 }, false).status).toBe("tooLong");
  });

  it("names the checkout in the scope switch", () => {
    expect(notesScopeOptions("fix/mobile").map((option) => option.label)).toEqual([
      "fix/mobile",
      "Project",
    ]);
    expect(notesScopeOptions(null)[0]?.label).toBe("Main checkout");
  });

  it("lists every scope with unsaved text, not just the one shown", () => {
    const documents = { worktree: { body: "a", revision: 1 }, project: { body: "p", revision: 2 } };
    expect(
      unsavedNoteScopes(
        { worktree: { body: "a!", baseRevision: 1 }, project: { body: "p", baseRevision: 2 } },
        (scope) => documents[scope],
      ),
    ).toEqual(["worktree"]);
    expect(unsavedNoteScopes({}, () => null)).toEqual([]);
  });
});
