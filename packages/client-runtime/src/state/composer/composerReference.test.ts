import {
  BROWSER_ELEMENT_MAX_PER_PROMPT,
  type ProjectBrowserPickedElement,
} from "@ryco/contracts/project-browser";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../../scoped.ts";
import {
  type BrowserElementReferenceDraft,
  createBrowserElementReference,
} from "./browserElementReference.ts";
import {
  addComposerReferenceDraft,
  type ComposerReferenceDraft,
  composerReferenceKey,
  decodeComposerReferenceDraft,
  formatComposerReferenceTitle,
  isBrowserElementReference,
  normalizeComposerReferenceDrafts,
  splitComposerReferences,
} from "./composerReference.ts";
import type { ComposerDraftStorage } from "./draftSplitStorage.ts";
import { createComposerDraftStore } from "./draftStore.ts";
import {
  createFileReference,
  FILE_REFERENCE_PROMPT_MAX_COUNT,
  type FileReferenceDraft,
} from "./fileReference.ts";

const createdAt = "2026-10-28T00:00:00.000Z";

function file(id: string, lineStart: number): FileReferenceDraft {
  const created = createFileReference({
    path: "src/app.ts",
    lineStart,
    lineEnd: lineStart,
    lines: ["const a = 1;"],
  });
  if (!created) throw new Error("fixture reference is invalid");
  return { ...created, id, createdAt };
}

const picked: ProjectBrowserPickedElement = {
  url: "http://localhost:3000/settings",
  pageTitle: "Settings",
  selector: "#save",
  tagName: "button",
  role: "button",
  name: "Save",
  text: "Save",
  box: { x: 1, y: 2, width: 3, height: 4 },
};

function element(id: string, selector = "#save", comment?: string): BrowserElementReferenceDraft {
  const created = createBrowserElementReference({ ...picked, selector, comment });
  if (!created) throw new Error("fixture element is invalid");
  return { ...created, id, createdAt };
}

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => file(`f${index}`, index + 1));
const elements = (count: number) =>
  Array.from({ length: count }, (_, index) => element(`e${index}`, `#item-${index}`));

describe("composer references", () => {
  it("tells the kinds apart and keys them without collisions", () => {
    expect(isBrowserElementReference(element("e"))).toBe(true);
    expect(isBrowserElementReference(file("f", 1))).toBe(false);
    expect(composerReferenceKey(element("e"))).not.toBe(composerReferenceKey(file("f", 1)));
    expect(formatComposerReferenceTitle(element("e"))).toBe(
      'button "Save" on localhost:3000/settings',
    );
    expect(formatComposerReferenceTitle(file("f", 3))).toBe("src/app.ts line 3");
    const mixed = [file("f1", 1), element("e1"), file("f2", 2)];
    expect(splitComposerReferences(mixed)).toEqual({
      fileReferences: [mixed[0], mixed[2]],
      browserElements: [mixed[1]],
    });
  });

  it("caps each kind on its own: 20 files and 32 page elements", () => {
    let references: ComposerReferenceDraft[] = [];
    for (const reference of [...files(FILE_REFERENCE_PROMPT_MAX_COUNT), ...elements(31)]) {
      const next = addComposerReferenceDraft(references, reference);
      expect(next.outcome).toBe("added");
      references = next.references;
    }
    // Files are full, page elements are not.
    expect(addComposerReferenceDraft(references, file("one-more", 99)).outcome).toBe("full");
    const added = addComposerReferenceDraft(references, element("e31", "#item-31"));
    expect(added.outcome).toBe("added");
    references = added.references;
    expect(references).toHaveLength(
      FILE_REFERENCE_PROMPT_MAX_COUNT + BROWSER_ELEMENT_MAX_PER_PROMPT,
    );
    expect(addComposerReferenceDraft(references, element("extra", "#extra")).outcome).toBe("full");

    const kept = normalizeComposerReferenceDrafts([
      ...elements(BROWSER_ELEMENT_MAX_PER_PROMPT + 3),
      ...files(FILE_REFERENCE_PROMPT_MAX_COUNT + 3),
    ]);
    expect(splitComposerReferences(kept).browserElements).toHaveLength(
      BROWSER_ELEMENT_MAX_PER_PROMPT,
    );
    expect(splitComposerReferences(kept).fileReferences).toHaveLength(
      FILE_REFERENCE_PROMPT_MAX_COUNT,
    );
  });

  it("updates an element picked again with the same note in place, keeping its id", () => {
    const first = addComposerReferenceDraft([file("f", 1)], element("e1", "#save", "Bigger"));
    const moved = { ...element("e2", "#save", "Bigger"), box: { x: 9, y: 9, width: 3, height: 4 } };
    const repeat = addComposerReferenceDraft(first.references, moved);
    expect(repeat.outcome).toBe("updated");
    expect(repeat.references.map((entry) => entry.id)).toEqual(["f", "e1"]);
    expect(repeat.references[1]).toMatchObject({ comment: "Bigger", box: moved.box });
    // Even when the kind is full, a repeat still updates.
    const full = elements(BROWSER_ELEMENT_MAX_PER_PROMPT);
    expect(addComposerReferenceDraft(full, element("again", "#item-0")).outcome).toBe("updated");
  });

  it("never drops a note: the same selector on the same URL with another note is another chip", () => {
    // Picks on #/settings and #/billing share the URL once the hash is dropped.
    const first = addComposerReferenceDraft([], element("e1", "#save", "Note A"));
    const second = addComposerReferenceDraft(first.references, element("e2", "#save", "Note B"));
    expect(second.outcome).toBe("added");
    expect(second.references.map((entry) => [entry.id, entry.comment])).toEqual([
      ["e1", "Note A"],
      ["e2", "Note B"],
    ]);
    expect(normalizeComposerReferenceDrafts(second.references)).toHaveLength(2);
  });

  it("keeps the first of repeated ids or keys across kinds", () => {
    const kept = normalizeComposerReferenceDrafts([
      element("a"),
      file("a", 1),
      element("b"),
      file("c", 1),
      file("d", 1),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("decodes both kinds, and entries without a kind as file references", () => {
    const fileDraft = file("f", 1);
    const elementDraft = element("e", "#save", "note");
    const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));
    expect(decodeComposerReferenceDraft(roundTrip(fileDraft))).toEqual(fileDraft);
    expect(decodeComposerReferenceDraft(roundTrip(elementDraft))).toEqual(elementDraft);
    // A kind this client does not know is dropped, not misread.
    expect(decodeComposerReferenceDraft({ ...roundTrip(fileDraft), kind: "image" })).toBeNull();
    expect(decodeComposerReferenceDraft({ ...roundTrip(elementDraft), kind: "file" })).toBeNull();
    expect(decodeComposerReferenceDraft(null)).toBeNull();
    expect(decodeComposerReferenceDraft("text")).toBeNull();
  });
});

describe("composer draft page elements", () => {
  function makeStore() {
    const values = new Map<string, string>();
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
    return () => useComposerDraftStore.getState();
  }
  const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));

  it("adds page elements next to file references, each kind within its own cap", () => {
    const state = makeStore();
    for (const reference of files(FILE_REFERENCE_PROMPT_MAX_COUNT)) {
      expect(state().addFileReference(threadRef, reference)).toBe("added");
    }
    expect(state().addFileReference(threadRef, file("one-more", 99))).toBe("full");
    expect(state().addFileReference(threadRef, element("e", "#save", "a"))).toBe("added");
    expect(state().addFileReference(threadRef, element("e2", "#save", "a"))).toBe("updated");
    const references = state().getComposerDraft(threadRef)?.fileReferences ?? [];
    expect(references).toHaveLength(FILE_REFERENCE_PROMPT_MAX_COUNT + 1);
    expect(references.at(-1)).toMatchObject({ id: "e", kind: "browser-element", comment: "a" });

    state().removeFileReference(threadRef, "e");
    expect(
      splitComposerReferences(state().getComposerDraft(threadRef)?.fileReferences ?? []),
    ).toMatchObject({ browserElements: [] });
  });
});
