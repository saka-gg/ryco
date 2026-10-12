import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import { createComposerDraftStore, DraftId, type ComposerDraftStorage } from "./draftStore.ts";
import { COMPOSER_DRAFT_STORAGE_KEY } from "./draftPersistence.ts";

function makeStorage(options: { deferred: boolean }) {
  const values = new Map<string, string>();
  const pending: Array<{ name: string; serialize: () => string }> = [];
  const setItem = vi.fn((name: string, value: string) => {
    values.set(name, value);
  });
  const storage: ComposerDraftStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem,
    removeItem: (name) => {
      values.delete(name);
    },
    ...(options.deferred
      ? {
          setItemDeferred: (name: string, serialize: () => string) => {
            pending.splice(0, pending.length, { name, serialize });
          },
        }
      : {}),
  };
  const flush = () => {
    for (const write of pending.splice(0)) values.set(write.name, write.serialize());
  };
  return { storage, values, setItem, flush, pending };
}

function makeStore(storage: ComposerDraftStorage, flushStorage: () => void = () => undefined) {
  return createComposerDraftStore({
    storage,
    flushStorage,
    revokePreviewUrl: () => undefined,
    hydrateImages: () => [],
    readPersistedAttachmentIds: () => [],
  });
}

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));

describe("composer draft persistence", () => {
  it("defers serialization to the storage flush when the storage supports it", () => {
    const { storage, values, setItem, flush, pending } = makeStorage({ deferred: true });
    const { useComposerDraftStore } = makeStore(storage);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (const prompt of ["h", "he", "hel", "hell", "hello"]) {
        useComposerDraftStore.getState().setPrompt(threadRef, prompt);
      }
      // Typing serializes nothing: the latest state waits for the flush.
      expect(stringify).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      expect(pending).toHaveLength(1);
      flush();
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
    const persisted = JSON.parse(values.get(COMPOSER_DRAFT_STORAGE_KEY) ?? "null");
    expect(persisted.state.draftsByThreadKey[scopedThreadKey(threadRef)].prompt).toBe("hello");
  });

  it("keeps eager serialization for plain storage", () => {
    const { storage, values, setItem } = makeStorage({ deferred: false });
    const { useComposerDraftStore } = makeStore(storage);
    useComposerDraftStore.getState().setPrompt(threadRef, "eager");
    expect(setItem).toHaveBeenCalled();
    const persisted = JSON.parse(values.get(COMPOSER_DRAFT_STORAGE_KEY) ?? "null");
    expect(persisted.state.draftsByThreadKey[scopedThreadKey(threadRef)].prompt).toBe("eager");
  });

  it("promotes every draft of materialized threads in one pass", () => {
    const { storage } = makeStorage({ deferred: true });
    const store = makeStore(storage);
    const projectId = ProjectId.make("project");
    const environmentId = threadRef.environmentId;
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
});
