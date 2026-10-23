import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import {
  createComposerDraftStore,
  DraftId,
  hasVerifiedPersistedAttachment,
  type ComposerDraftImage,
} from "./draftStore.ts";
import {
  COMPOSER_DRAFT_INDEX_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  composerDraftEntryStorageKey,
  type PersistedComposerImageAttachment,
} from "./draftPersistence.ts";
import type { ComposerDraftStorage } from "./draftSplitStorage.ts";

function makeStorage(
  options: {
    readonly scheduled?: boolean;
    readonly async?: boolean;
    readonly initial?: Record<string, string>;
    /** Shared with another storage: two tabs over one localStorage. */
    readonly values?: Map<string, string>;
  } = {},
) {
  const values = options.values ?? new Map<string, string>(Object.entries(options.initial ?? {}));
  let pendingFlush: (() => void) | null = null;
  const setItem = vi.fn((name: string, value: string) => {
    values.set(name, value);
  });
  const removeItem = vi.fn((name: string) => {
    values.delete(name);
  });
  const releaseAttachments = vi.fn((_ids: ReadonlyArray<string>) => undefined);
  const storage: ComposerDraftStorage = {
    getItem: (name) =>
      options.async ? Promise.resolve(values.get(name) ?? null) : (values.get(name) ?? null),
    setItem,
    removeItem,
    keys: () => values.keys(),
    releaseAttachments,
    ...(options.scheduled
      ? {
          scheduleWrite: (flush: () => void) => {
            pendingFlush = flush;
          },
        }
      : {}),
  };
  const flush = () => {
    const run = pendingFlush;
    pendingFlush = null;
    run?.();
  };
  return { storage, values, setItem, removeItem, releaseAttachments, flush };
}

function makeStore(
  storage: ComposerDraftStorage,
  hydrateImages: (
    attachments: ReadonlyArray<PersistedComposerImageAttachment>,
  ) => ComposerDraftImage[] = () => [],
) {
  return createComposerDraftStore({
    storage,
    flushStorage: () => undefined,
    revokePreviewUrl: () => undefined,
    hydrateImages,
    readPersistedAttachmentIds: () => [],
  });
}

const environmentId = EnvironmentId.make("environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const otherThreadRef = scopeThreadRef(environmentId, ThreadId.make("other"));
const entryOf = (values: Map<string, string>, ref: typeof threadRef) =>
  JSON.parse(values.get(composerDraftEntryStorageKey(scopedThreadKey(ref))) ?? "null");

const localImage = (id: string): PersistedComposerImageAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 4,
  bytes: "local",
});

describe("composer draft persistence", () => {
  it("serializes nothing while typing and only the changed draft when it flushes", () => {
    const { storage, values, setItem, flush } = makeStorage({ scheduled: true });
    const { useComposerDraftStore } = makeStore(storage);
    useComposerDraftStore.getState().setPrompt(otherThreadRef, "left alone");
    flush();
    setItem.mockClear();

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (const prompt of ["h", "he", "hel", "hell", "hello"]) {
        useComposerDraftStore.getState().setPrompt(threadRef, prompt);
      }
      // Typing serializes nothing: the latest state waits for the flush.
      expect(stringify).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      flush();
      // The new draft and the index that lists it; the other draft is untouched.
      expect(stringify).toHaveBeenCalledTimes(2);
    } finally {
      stringify.mockRestore();
    }
    expect(setItem.mock.calls.map(([name]) => name).toSorted()).toEqual(
      [
        COMPOSER_DRAFT_INDEX_STORAGE_KEY,
        composerDraftEntryStorageKey(scopedThreadKey(threadRef)),
      ].toSorted(),
    );
    expect(entryOf(values, threadRef).prompt).toBe("hello");
    expect(entryOf(values, otherThreadRef).prompt).toBe("left alone");

    // Another keystroke rewrites that one entry, not the index.
    setItem.mockClear();
    useComposerDraftStore.getState().setPrompt(threadRef, "hello!");
    flush();
    expect(setItem.mock.calls.map(([name]) => name)).toEqual([
      composerDraftEntryStorageKey(scopedThreadKey(threadRef)),
    ]);
  });

  it("writes the changed draft right away when the platform schedules no writes", () => {
    const { storage, values, setItem } = makeStorage();
    const { useComposerDraftStore } = makeStore(storage);
    useComposerDraftStore.getState().setPrompt(threadRef, "a");
    expect(entryOf(values, threadRef).prompt).toBe("a");
    setItem.mockClear();
    useComposerDraftStore.getState().setPrompt(threadRef, "ab");
    expect(entryOf(values, threadRef).prompt).toBe("ab");
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("round-trips through the split entries, also from async storage", async () => {
    const first = makeStorage({ scheduled: true });
    const writer = makeStore(first.storage);
    writer.useComposerDraftStore.getState().setPrompt(threadRef, "kept");
    writer.useComposerDraftStore.getState().setRuntimeMode(otherThreadRef, "approval-required");
    first.flush();

    const sync = makeStore(makeStorage({ initial: Object.fromEntries(first.values) }).storage);
    expect(sync.useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe("kept");

    const asyncStore = makeStore(
      makeStorage({ async: true, initial: Object.fromEntries(first.values) }).storage,
    );
    await vi.waitFor(() =>
      expect(asyncStore.useComposerDraftStore.persist.hasHydrated()).toBe(true),
    );
    const state = asyncStore.useComposerDraftStore.getState();
    expect(state.getComposerDraft(threadRef)?.prompt).toBe("kept");
    expect(state.getComposerDraft(otherThreadRef)?.runtimeMode).toBe("approval-required");
  });

  it("migrates the single legacy entry without losing a draft, then removes it", () => {
    const legacy = {
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      state: {
        draftsByThreadKey: {
          [scopedThreadKey(threadRef)]: { prompt: "first", attachments: [] },
          [scopedThreadKey(otherThreadRef)]: { prompt: "second", attachments: [] },
        },
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      },
    };
    const { storage, values, flush } = makeStorage({
      scheduled: true,
      initial: { [COMPOSER_DRAFT_STORAGE_KEY]: JSON.stringify(legacy) },
    });
    const { useComposerDraftStore } = makeStore(storage);
    expect(useComposerDraftStore.getState().getComposerDraft(otherThreadRef)?.prompt).toBe(
      "second",
    );
    // Nothing is rewritten until something changes; the legacy entry is still there.
    expect(values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(true);

    useComposerDraftStore.getState().setPrompt(threadRef, "first, edited");
    flush();
    expect(values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
    expect(entryOf(values, threadRef).prompt).toBe("first, edited");
    expect(entryOf(values, otherThreadRef).prompt).toBe("second");
    expect(JSON.parse(values.get(COMPOSER_DRAFT_INDEX_STORAGE_KEY)!).state.draftKeys).toHaveLength(
      2,
    );
  });

  it("keeps the legacy entry when the new index cannot be written", () => {
    const legacy = {
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      state: {
        draftsByThreadKey: { [scopedThreadKey(threadRef)]: { prompt: "safe", attachments: [] } },
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      },
    };
    const { storage, values, setItem, flush } = makeStorage({
      scheduled: true,
      initial: { [COMPOSER_DRAFT_STORAGE_KEY]: JSON.stringify(legacy) },
    });
    const onWriteError = vi.fn();
    const { useComposerDraftStore } = makeStore({ ...storage, onWriteError });
    setItem.mockImplementation((name: string, value: string) => {
      if (name === COMPOSER_DRAFT_INDEX_STORAGE_KEY) throw new Error("QuotaExceededError");
      values.set(name, value);
    });
    useComposerDraftStore.getState().setPrompt(threadRef, "safe, edited");
    flush();
    expect(onWriteError).toHaveBeenCalledWith(COMPOSER_DRAFT_INDEX_STORAGE_KEY, expect.any(Error));
    expect(values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(true);
  });

  it("removes a cleared draft's entry and releases bytes no draft references", () => {
    const { storage, values, releaseAttachments, flush } = makeStorage({ scheduled: true });
    const { useComposerDraftStore } = makeStore(storage);
    const state = () => useComposerDraftStore.getState();
    state().setPrompt(threadRef, "with images");
    state().syncPersistedAttachments(threadRef, [localImage("shared"), localImage("only-here")]);
    state().setPrompt(otherThreadRef, "also shared");
    state().syncPersistedAttachments(otherThreadRef, [localImage("shared")]);
    flush();
    expect(releaseAttachments).not.toHaveBeenCalled();

    state().clearComposerContent(threadRef);
    flush();
    expect(values.has(composerDraftEntryStorageKey(scopedThreadKey(threadRef)))).toBe(false);
    expect(releaseAttachments).toHaveBeenCalledExactlyOnceWith(["only-here"]);
  });

  it("removes draft entries no index lists", () => {
    const first = makeStorage({ scheduled: true });
    const writer = makeStore(first.storage);
    writer.useComposerDraftStore.getState().setPrompt(threadRef, "listed");
    first.flush();
    const orphan = composerDraftEntryStorageKey("orphaned-thread");
    const reopened = makeStorage({
      scheduled: true,
      initial: { ...Object.fromEntries(first.values), [orphan]: '{"prompt":"x","attachments":[]}' },
    });
    const { useComposerDraftStore } = makeStore(reopened.storage);
    useComposerDraftStore.getState().setPrompt(threadRef, "listed, edited");
    reopened.flush();
    expect(reopened.values.has(orphan)).toBe(false);
    expect(entryOf(reopened.values, threadRef).prompt).toBe("listed, edited");
  });

  it("restores hydrated images in place and drops ones whose bytes are gone", () => {
    const first = makeStorage({ scheduled: true });
    const writer = makeStore(first.storage);
    writer.useComposerDraftStore.getState().setPrompt(threadRef, "pictures");
    writer.useComposerDraftStore
      .getState()
      .syncPersistedAttachments(threadRef, [localImage("present"), localImage("missing")]);
    first.flush();

    const pendingImage = (attachment: PersistedComposerImageAttachment): ComposerDraftImage => ({
      type: "image",
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: "",
    });
    const { useComposerDraftStore } = makeStore(
      makeStorage({ initial: Object.fromEntries(first.values) }).storage,
      (attachments) => attachments.map(pendingImage),
    );
    const key = scopedThreadKey(threadRef);
    expect(useComposerDraftStore.getState().draftsByThreadKey[key]?.images).toHaveLength(2);
    useComposerDraftStore.getState().restoreDraftImages(key, [
      { id: "present", image: { ...pendingImage(localImage("present")), previewUrl: "blob:x" } },
      { id: "missing", image: null },
    ]);
    const draft = useComposerDraftStore.getState().draftsByThreadKey[key]!;
    expect(draft.images.map((image) => [image.id, image.previewUrl])).toEqual([
      ["present", "blob:x"],
    ]);
    expect(draft.persistedAttachments.map((attachment) => attachment.id)).toEqual(["present"]);
  });

  it("counts a staged attachment as saved only once storage reads it back", async () => {
    const { storage, values } = makeStorage();
    let storedIds: string[] = [];
    const { useComposerDraftStore } = createComposerDraftStore<ComposerDraftImage>({
      storage,
      flushStorage: () => undefined,
      revokePreviewUrl: () => undefined,
      hydrateImages: () => [],
      readPersistedAttachmentIds: () => storedIds,
    });
    const image = (id: string): ComposerDraftImage => ({
      type: "image",
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: `blob:${id}`,
    });
    const draft = () => useComposerDraftStore.getState().getComposerDraft(threadRef)!;
    useComposerDraftStore.getState().addImages(threadRef, [image("kept"), image("lost")]);
    // The write keeps one of the two, e.g. storage filled up.
    storedIds = ["kept"];
    useComposerDraftStore
      .getState()
      .syncPersistedAttachments(threadRef, [localImage("kept"), localImage("lost")]);
    expect(hasVerifiedPersistedAttachment(draft(), "kept")).toBe(false);

    await Promise.resolve();
    expect(hasVerifiedPersistedAttachment(draft(), "kept")).toBe(true);
    expect(hasVerifiedPersistedAttachment(draft(), "lost")).toBe(false);

    // A draft hydrated from storage holds what storage holds.
    const hydrated = createComposerDraftStore<ComposerDraftImage>({
      storage: makeStorage({ initial: Object.fromEntries(values) }).storage,
      flushStorage: () => undefined,
      revokePreviewUrl: () => undefined,
      hydrateImages: () => [],
      readPersistedAttachmentIds: () => [],
    });
    const restored = hydrated.useComposerDraftStore.getState().getComposerDraft(threadRef)!;
    expect(hasVerifiedPersistedAttachment(restored, "kept")).toBe(true);
  });

  it("verifies a staged draft under the key it moved to before the read-back", async () => {
    const { storage } = makeStorage();
    const draftKey = "draft-before-promotion";
    const threadKey = scopedThreadKey(threadRef);
    const readKeys: string[] = [];
    const { useComposerDraftStore } = createComposerDraftStore<ComposerDraftImage>({
      storage,
      flushStorage: () => undefined,
      revokePreviewUrl: () => undefined,
      hydrateImages: () => [],
      readPersistedAttachmentIds: (key) => {
        readKeys.push(key);
        return key === threadKey ? ["kept"] : [];
      },
    });
    const draftId = DraftId.make(draftKey);
    useComposerDraftStore.getState().addImages(draftId, [
      {
        type: "image",
        id: "kept",
        name: "kept.png",
        mimeType: "image/png",
        sizeBytes: 4,
        previewUrl: "blob:kept",
      },
    ]);
    useComposerDraftStore.getState().syncPersistedAttachments(draftId, [localImage("kept")]);
    // The draft moves to its thread's key (e.g. a promotion) before the read-back runs.
    useComposerDraftStore.setState((state) => {
      const { [draftKey]: moved, ...rest } = state.draftsByThreadKey;
      return { draftsByThreadKey: { ...rest, [threadKey]: moved! } };
    });

    await Promise.resolve();
    const draft = useComposerDraftStore.getState().draftsByThreadKey[threadKey]!;
    expect(readKeys).toEqual([threadKey]);
    expect(draft.persistedAttachmentsUnverified).toBeUndefined();
    expect(hasVerifiedPersistedAttachment(draft, "kept")).toBe(true);
  });

  it("promotes every draft of materialized threads in one pass", () => {
    const { storage } = makeStorage({ scheduled: true });
    const store = makeStore(storage);
    const projectId = ProjectId.make("project");
    const state = store.useComposerDraftStore.getState();
    for (const id of ["one", "two", "three"]) {
      state.setLogicalProjectDraftThreadId(
        `logical-${id}`,
        { environmentId, projectId },
        DraftId.make(`draft-${id}`),
        { threadId: ThreadId.make(`thread-${id}`), createdAt: "2026-10-01T00:00:00.000Z" },
      );
    }
    store.markPromotedDraftThreadsByRef([
      scopeThreadRef(environmentId, ThreadId.make("thread-one")),
      scopeThreadRef(environmentId, ThreadId.make("thread-three")),
      scopeThreadRef(environmentId, ThreadId.make("unrelated")),
    ]);
    const drafts = store.useComposerDraftStore.getState().draftThreadsByThreadKey;
    expect(drafts["draft-one"]?.promotedTo?.threadId).toBe("thread-one");
    expect(drafts["draft-two"]?.promotedTo ?? null).toBeNull();
    expect(drafts["draft-three"]?.promotedTo?.threadId).toBe("thread-three");
  });

  it("keeps the draft object when there are no attachments to clear", () => {
    const { storage } = makeStorage({ scheduled: true });
    const { useComposerDraftStore } = makeStore(storage);
    useComposerDraftStore.getState().setPrompt(threadRef, "no images");
    const before = useComposerDraftStore.getState().getComposerDraft(threadRef);
    useComposerDraftStore.getState().clearPersistedAttachments(threadRef);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)).toBe(before);

    useComposerDraftStore.getState().syncPersistedAttachments(threadRef, [localImage("one")]);
    useComposerDraftStore.getState().clearPersistedAttachments(threadRef);
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.persistedAttachments,
    ).toEqual([]);
  });

  describe("across tabs sharing one storage", () => {
    const thirdThreadRef = scopeThreadRef(environmentId, ThreadId.make("third"));
    const indexOf = (values: Map<string, string>) =>
      JSON.parse(values.get(COMPOSER_DRAFT_INDEX_STORAGE_KEY) ?? "null");
    const openTab = (values: Map<string, string>) => {
      const tab = makeStorage({ scheduled: true, values });
      const store = makeStore(tab.storage);
      return { ...tab, state: () => store.useComposerDraftStore.getState() };
    };
    const seeded = () => {
      const values = new Map<string, string>();
      const seed = openTab(values);
      seed.state().setPrompt(otherThreadRef, "shared");
      seed.flush();
      return values;
    };

    it("keeps a draft another tab created after this one booted", () => {
      const values = seeded();
      const tabA = openTab(values);
      const tabB = openTab(values);
      const projectId = ProjectId.make("project");
      tabA.state().setPrompt(threadRef, "started in A");
      tabA
        .state()
        .setLogicalProjectDraftThreadId(
          "logical-a",
          { environmentId, projectId },
          DraftId.make("a"),
          {
            threadId: ThreadId.make("thread-a"),
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        );
      tabA.flush();

      // B never saw A's draft and writes its own index.
      tabB.state().setPrompt(thirdThreadRef, "started in B");
      tabB.flush();
      // A keeps typing: only its draft entry changes.
      tabA.state().setPrompt(threadRef, "started in A, edited");
      tabA.flush();

      const reloaded = openTab(values);
      expect(reloaded.state().getComposerDraft(threadRef)?.prompt).toBe("started in A, edited");
      expect(reloaded.state().getComposerDraft(thirdThreadRef)?.prompt).toBe("started in B");
      expect(reloaded.state().getComposerDraft(otherThreadRef)?.prompt).toBe("shared");
      expect(reloaded.state().draftThreadsByThreadKey["a"]?.threadId).toBe("thread-a");
      expect(indexOf(values).state.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({
        "logical-a": "a",
      });
    });

    it("respects another tab's delete of a draft this tab left alone", () => {
      const values = seeded();
      const tabA = openTab(values);
      const tabB = openTab(values);
      tabB.state().clearComposerContent(otherThreadRef);
      tabB.flush();
      expect(values.has(composerDraftEntryStorageKey(scopedThreadKey(otherThreadRef)))).toBe(false);

      // A writes its index for an unrelated change, then again later.
      tabA.state().setPrompt(threadRef, "unrelated");
      tabA.flush();
      tabA.state().setPrompt(thirdThreadRef, "also unrelated");
      tabA.flush();

      expect(indexOf(values).state.draftKeys).not.toContain(scopedThreadKey(otherThreadRef));
      expect(values.has(composerDraftEntryStorageKey(scopedThreadKey(otherThreadRef)))).toBe(false);
      expect(openTab(values).state().getComposerDraft(otherThreadRef)?.prompt ?? "").toBe("");
    });

    it("keeps this tab's edit over another tab's delete of the same draft", () => {
      const values = seeded();
      const tabA = openTab(values);
      const tabB = openTab(values);
      tabB.state().clearComposerContent(otherThreadRef);
      tabB.flush();
      tabA.state().setPrompt(otherThreadRef, "shared, edited in A");
      tabA.flush();

      expect(openTab(values).state().getComposerDraft(otherThreadRef)?.prompt).toBe(
        "shared, edited in A",
      );
    });

    it("writes a draft again once it is edited after another tab deleted it", () => {
      const values = seeded();
      const tabA = openTab(values);
      const tabB = openTab(values);
      tabB.state().clearComposerContent(otherThreadRef);
      tabB.flush();
      tabA.state().setPrompt(threadRef, "unrelated");
      tabA.flush();
      tabA.state().setPrompt(otherThreadRef, "shared, back again");
      tabA.flush();

      expect(openTab(values).state().getComposerDraft(otherThreadRef)?.prompt).toBe(
        "shared, back again",
      );
    });

    it("respects another tab's delete of a draft thread this tab left alone", () => {
      const values = new Map<string, string>();
      const seed = openTab(values);
      seed
        .state()
        .setLogicalProjectDraftThreadId(
          "logical-a",
          { environmentId, projectId: ProjectId.make("project") },
          DraftId.make("d1"),
          { threadId: ThreadId.make("thread-d1"), createdAt: "2026-10-01T00:00:00.000Z" },
        );
      seed.state().setPrompt(otherThreadRef, "shared");
      seed.flush();
      const tabA = openTab(values);
      const tabB = openTab(values);
      tabB.state().clearDraftThread(DraftId.make("d1"));
      tabB.flush();

      // A's first index write since it booted, for an unrelated change.
      tabA.state().setPrompt(threadRef, "unrelated");
      tabA.flush();

      const reloaded = openTab(values);
      expect(reloaded.state().draftThreadsByThreadKey["d1"]).toBeUndefined();
      expect(reloaded.state().logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({});
      expect(reloaded.state().getComposerDraft(threadRef)?.prompt).toBe("unrelated");
    });

    it("writes its own index over one another tab stored in a different version", () => {
      const values = seeded();
      const tab = openTab(values);
      const index = indexOf(values);
      values.set(
        COMPOSER_DRAFT_INDEX_STORAGE_KEY,
        JSON.stringify({
          version: COMPOSER_DRAFT_STORAGE_VERSION + 1,
          state: {
            ...index.state,
            logicalProjectDraftThreadKeyByLogicalProjectKey: { "logical-z": "z" },
          },
        }),
      );
      tab.state().setPrompt(threadRef, "unrelated");
      tab.flush();

      expect(indexOf(values).version).toBe(COMPOSER_DRAFT_STORAGE_VERSION);
      expect(indexOf(values).state.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({});
      expect(openTab(values).state().getComposerDraft(otherThreadRef)?.prompt).toBe("shared");
    });

    it("does not sweep an entry the index lists by the time this tab flushes", () => {
      const values = seeded();
      const lateKey = scopedThreadKey(threadRef);
      // An entry no index lists yet when the tab boots...
      values.set(
        composerDraftEntryStorageKey(lateKey),
        JSON.stringify({ prompt: "late", attachments: [] }),
      );
      const tab = openTab(values);
      // ...which another tab then lists.
      const index = indexOf(values);
      values.set(
        COMPOSER_DRAFT_INDEX_STORAGE_KEY,
        JSON.stringify({
          ...index,
          state: { ...index.state, draftKeys: [...index.state.draftKeys, lateKey] },
        }),
      );
      tab.state().setPrompt(thirdThreadRef, "unrelated");
      tab.flush();

      expect(values.has(composerDraftEntryStorageKey(lateKey))).toBe(true);
      expect(indexOf(values).state.draftKeys).toContain(lateKey);
      expect(openTab(values).state().getComposerDraft(threadRef)?.prompt).toBe("late");
    });
  });
});
