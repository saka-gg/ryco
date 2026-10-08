import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { NotesCommand, NotesError, NotesSnapshot, WorktreeNote } from "./notes.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const note = {
  noteId: "note_1",
  revision: 0,
  projectId: "project",
  worktreeId: null,
  scope: "worktree",
  body: "[ ] Check the reconnect fence",
  threadId: "thread",
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
};
const create = {
  kind: "create",
  noteId: "note_1",
  projectId: "project",
  worktreeId: "worktree",
  scope: "project",
  body: "Pinned",
  threadId: null,
};
const decodeCommand = Schema.decodeUnknownSync(NotesCommand);

describe("worktree notes contract", () => {
  it("round-trips a snapshot", () => {
    const snapshot = { projectId: "project", notes: [note], limit: 500, truncated: false };
    const decoded = Schema.decodeUnknownSync(NotesSnapshot)(snapshot);
    expect(decoded.notes[0]?.worktreeId).toBeNull();
    expect(Schema.encodeSync(NotesSnapshot)(decoded)).toEqual(snapshot);
  });

  it("bounds note bodies, identifiers and revisions", () => {
    const decodeNote = Schema.decodeUnknownSync(WorktreeNote);
    expect(decodeNote({ ...note, body: "x".repeat(10_000) }).body).toHaveLength(10_000);
    for (const invalid of [
      { ...note, body: "" },
      { ...note, body: "x".repeat(10_001) },
      { ...note, noteId: "has space" },
      { ...note, noteId: "x".repeat(129) },
      { ...note, revision: -1 },
      { ...note, scope: "thread" },
    ])
      expect(() => decodeNote(invalid)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(NotesSnapshot)({
        projectId: "project",
        notes: [],
        limit: 0,
        truncated: false,
      }),
    ).toThrow();
  });

  it("decodes each command kind", () => {
    expect(decodeCommand(create).kind).toBe("create");
    expect(
      decodeCommand({
        kind: "update",
        noteId: "note_1",
        projectId: "project",
        expectedRevision: 2,
        scope: "worktree",
      }),
    ).toEqual({
      kind: "update",
      noteId: "note_1",
      projectId: "project",
      expectedRevision: 2,
      scope: "worktree",
    });
    expect(
      decodeCommand({ kind: "delete", noteId: "note_1", projectId: "project", expectedRevision: 0 })
        .kind,
    ).toBe("delete");
    expect(() => decodeCommand({ ...create, kind: "restore" })).toThrow();
    expect(() =>
      decodeCommand({ kind: "update", noteId: "note_1", projectId: "project" }),
    ).toThrow();
  });

  it("rejects excess properties instead of silently dropping them", () => {
    expect(() => decodeCommand({ ...create, revision: 4 })).toThrow();
    expect(() => decodeCommand({ ...create, createdAt: note.createdAt })).toThrow();
    expect(() =>
      decodeCommand({
        kind: "delete",
        noteId: "note_1",
        projectId: "project",
        expectedRevision: 0,
        body: "smuggled",
      }),
    ).toThrow();
  });

  it("is part of the one wire API", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.notesList)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.notesCommand)).toBe(true);
  });

  it("tags its error", () => {
    const error = new NotesError({ reason: "conflict", message: "Changed" });
    expect(error._tag).toBe("NotesError");
    expect(Schema.is(NotesError)(error)).toBe(true);
  });
});
