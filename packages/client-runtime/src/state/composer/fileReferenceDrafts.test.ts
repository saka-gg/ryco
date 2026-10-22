import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import { composerDraftEntryStorageKey } from "./draftPersistence.ts";
import type { ComposerDraftStorage } from "./draftSplitStorage.ts";
import { createComposerDraftStore } from "./draftStore.ts";
import {
  addFileReferenceDraft,
  createFileReference,
  decodeFileReferenceDraft,
  FILE_REFERENCE_PROMPT_MAX_COUNT,
  type FileReferenceDraft,
  normalizeFileReferenceDrafts,
} from "./fileReference.ts";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const entryKey = composerDraftEntryStorageKey(scopedThreadKey(threadRef));

function reference(
  id: string,
  lineStart: number,
  overrides: { readonly comment?: string; readonly path?: string } = {},
): FileReferenceDraft {
  const created = createFileReference({
    path: overrides.path ?? "src/app.ts",
    lineStart,
    lineEnd: lineStart + 1,
    side: "new",
    lines: ["const a = 1;", "const b = 2;"],
    comment: overrides.comment,
  });
  if (!created) throw new Error("fixture reference is invalid");
  return { ...created, id, createdAt: "2026-10-22T00:00:00.000Z" };
}

function makeStore(values = new Map<string, string>()) {
  const storage: ComposerDraftStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
    keys: () => values.keys(),
    releaseAttachments: () => undefined,
  };
  const { useComposerDraftStore } = createComposerDraftStore({
    storage,
    flushStorage: () => undefined,
    revokePreviewUrl: () => undefined,
    hydrateImages: () => [],
    readPersistedAttachmentIds: () => [],
  });
  return { values, state: () => useComposerDraftStore.getState() };
}

describe("file reference drafts", () => {
  it("adds references in order and replaces one for the same lines in place", () => {
    const first = reference("a", 1);
    const second = reference("b", 10);
    let references = addFileReferenceDraft([], first).references;
    references = addFileReferenceDraft(references, second).references;
    const repeat = addFileReferenceDraft(references, reference("c", 1, { comment: "Why?" }));

    expect(repeat.outcome).toBe("updated");
    expect(repeat.references.map((entry) => [entry.id, entry.comment])).toEqual([
      ["a", "Why?"],
      ["b", undefined],
    ]);
  });

  it("refuses a reference past the prompt's limit", () => {
    const full = Array.from({ length: FILE_REFERENCE_PROMPT_MAX_COUNT }, (_, index) =>
      reference(`r${index}`, index * 10 + 1),
    );
    expect(addFileReferenceDraft(full, reference("extra", 999)).outcome).toBe("full");
    // The same lines are still an update, not a new one.
    expect(addFileReferenceDraft(full, reference("again", 1)).outcome).toBe("updated");
  });

  it("keeps the first of repeated ids or ranges, within the limit", () => {
    const kept = normalizeFileReferenceDrafts([
      reference("a", 1),
      reference("a", 5),
      reference("b", 1),
      ...Array.from({ length: FILE_REFERENCE_PROMPT_MAX_COUNT + 5 }, (_, index) =>
        reference(`r${index}`, index * 10 + 20),
      ),
    ]);
    expect(kept).toHaveLength(FILE_REFERENCE_PROMPT_MAX_COUNT);
    expect(kept[0]?.id).toBe("a");
    expect(kept[1]?.id).toBe("r0");
  });

  it("reads back only drafts that hold up as references", () => {
    const valid = reference("a", 1, { comment: "note" });
    expect(decodeFileReferenceDraft(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(decodeFileReferenceDraft({ ...valid, id: "" })).toBeNull();
    expect(decodeFileReferenceDraft({ ...valid, createdAt: 1 })).toBeNull();
    expect(decodeFileReferenceDraft({ ...valid, path: "../outside.ts" })).toBeNull();
    expect(decodeFileReferenceDraft({ ...valid, lineStart: 0 })).toBeNull();
  });
});

describe("composer draft file references", () => {
  it("adds, updates, refuses and removes references, and a draft holding only them is kept", () => {
    const { state } = makeStore();
    expect(state().addFileReference(threadRef, reference("a", 1))).toBe("added");
    expect(state().addFileReference(threadRef, reference("b", 1, { comment: "x" }))).toBe(
      "updated",
    );
    expect(
      state()
        .getComposerDraft(threadRef)
        ?.fileReferences.map((entry) => entry.id),
    ).toEqual(["a"]);

    state().removeFileReference(threadRef, "a");
    // Nothing else was in the draft, so it is gone.
    expect(state().getComposerDraft(threadRef)).toBeNull();
  });

  it("clears references with the rest of the content on send, and keeps them through a stash", () => {
    const { state } = makeStore();
    state().setPrompt(threadRef, "look");
    state().addFileReference(threadRef, reference("a", 1));

    state().clearPromptAndImages(threadRef);
    expect(state().getComposerDraft(threadRef)?.fileReferences).toHaveLength(1);

    state().clearComposerContent(threadRef);
    expect(state().getComposerDraft(threadRef)?.fileReferences ?? []).toHaveLength(0);
  });

  it("restores references de-duplicated and capped", () => {
    const { state } = makeStore();
    state().setFileReferences(threadRef, [reference("a", 1), reference("b", 1), reference("c", 5)]);
    expect(
      state()
        .getComposerDraft(threadRef)
        ?.fileReferences.map((entry) => entry.id),
    ).toEqual(["a", "c"]);
    state().setFileReferences(threadRef, []);
    expect(state().getComposerDraft(threadRef)).toBeNull();
  });

  it("persists references and drops ones that no longer hold up when they come back", () => {
    const writer = makeStore();
    writer.state().addFileReference(threadRef, reference("a", 1, { comment: "note" }));
    writer.state().addFileReference(threadRef, reference("b", 10));
    const stored = JSON.parse(writer.values.get(entryKey) ?? "null");
    expect(stored.fileReferences).toHaveLength(2);

    // A tampered entry: one reference names a path outside the workspace.
    stored.fileReferences[1].path = "../../etc/passwd";
    writer.values.set(entryKey, JSON.stringify(stored));
    const reader = makeStore(writer.values);
    const restored = reader.state().getComposerDraft(threadRef)?.fileReferences ?? [];
    expect(restored).toEqual([reference("a", 1, { comment: "note" })]);
  });
});
