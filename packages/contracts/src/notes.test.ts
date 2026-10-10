import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  NOTE_BODY_MAX_LENGTH,
  NotesCommand,
  NotesDocument,
  NotesError,
  NotesSnapshot,
} from "./notes.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const document = {
  projectId: "project",
  scope: "worktree",
  worktreeId: null,
  body: "Check the reconnect fence",
  revision: 1,
  updatedAt: "2026-10-07T00:00:00.000Z",
};
const save = {
  kind: "save",
  projectId: "project",
  scope: "worktree",
  worktreeId: "worktree",
  body: "Draft",
  expectedRevision: 0,
};
const decodeCommand = Schema.decodeUnknownSync(NotesCommand);

describe("notes contract", () => {
  it("round-trips a snapshot", () => {
    const snapshot = { projectId: "project", documents: [document] };
    const decoded = Schema.decodeUnknownSync(NotesSnapshot)(snapshot);
    expect(decoded.documents[0]?.worktreeId).toBeNull();
    expect(Schema.encodeSync(NotesSnapshot)(decoded)).toEqual(snapshot);
  });

  it("bounds bodies and revisions, and allows a cleared document", () => {
    const decodeDocument = Schema.decodeUnknownSync(NotesDocument);
    expect(decodeDocument({ ...document, body: "" }).body).toBe("");
    expect(
      decodeDocument({ ...document, body: "x".repeat(NOTE_BODY_MAX_LENGTH) }).body,
    ).toHaveLength(NOTE_BODY_MAX_LENGTH);
    for (const invalid of [
      { ...document, body: "x".repeat(NOTE_BODY_MAX_LENGTH + 1) },
      { ...document, revision: -1 },
      { ...document, scope: "thread" },
    ])
      expect(() => decodeDocument(invalid)).toThrow();
  });

  it("decodes a save", () => {
    expect(decodeCommand(save)).toEqual(save);
    expect(decodeCommand({ ...save, body: "" }).body).toBe("");
    expect(() => decodeCommand({ ...save, kind: "create" })).toThrow();
    expect(() => decodeCommand({ ...save, expectedRevision: undefined })).toThrow();
  });

  it("rejects excess properties instead of silently dropping them", () => {
    expect(() => decodeCommand({ ...save, revision: 4 })).toThrow();
    expect(() => decodeCommand({ ...save, threadId: "thread" })).toThrow();
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
