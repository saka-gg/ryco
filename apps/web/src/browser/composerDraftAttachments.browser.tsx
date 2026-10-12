// The app loads the draft store before its persistence adapter (they import each other).
import "../composerDraftStore";

import {
  COMPOSER_DRAFT_INDEX_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  composerDraftEntryStorageKey,
  createComposerDraftStore,
} from "@ryco/client-runtime/state/composer";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createComposerAttachmentBytesStore } from "../composerAttachmentBytes";
import {
  composerAttachmentBytes,
  composerDraftStorage,
  composerDraftWriteScheduler,
  hydrateDraftImagesFromPersisted,
  persistComposerImageBytes,
  readPersistedAttachmentIdsFromStorage,
  resetComposerAttachmentRestoreForTests,
  restoreComposerDraftAttachments,
} from "../composerDraftPersistence";
import type { ComposerImageAttachment } from "../composerDraftStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-drafts"), ThreadId.make("thread-images"));
const threadKey = scopedThreadKey(threadRef);

/** A fresh store over the real browser storage, as a page load would create it. */
function loadStore() {
  return createComposerDraftStore<ComposerImageAttachment>({
    storage: composerDraftStorage,
    flushStorage: () => composerDraftWriteScheduler.flush(),
    revokePreviewUrl: () => undefined,
    hydrateImages: hydrateDraftImagesFromPersisted,
    readPersistedAttachmentIds: readPersistedAttachmentIdsFromStorage,
  }).useComposerDraftStore;
}

function imageFile(id: string, text: string): ComposerImageAttachment {
  const file = new File([text], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

function clearDraftStorage() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("ryco:composer-draft")) localStorage.removeItem(key);
  }
}

describe("composer draft attachments", () => {
  afterEach(async () => {
    clearDraftStorage();
    resetComposerAttachmentRestoreForTests();
    await composerAttachmentBytes?.deleteUnreferenced(new Set(), Number.POSITIVE_INFINITY);
  });

  it("stores, reads and collects bytes in IndexedDB", async () => {
    const store = createComposerAttachmentBytesStore(indexedDB, () => 1_000, "ryco-test-bytes");
    await store.put("one", new Blob(["first"]));
    await store.put("two", new Blob(["second"]));
    const read = await store.getMany(["one", "two", "missing"]);
    expect([...read.keys()].toSorted()).toEqual(["one", "two"]);
    expect(await read.get("two")!.text()).toBe("second");
    expect(await store.deleteUnreferenced(new Set(["one"]), 2_000)).toBe(1);
    // Too recent to collect: another tab may still be writing its draft.
    expect(await store.deleteUnreferenced(new Set(), 500)).toBe(0);
    await store.deleteMany(["one"]);
    expect((await store.getMany(["one", "two"])).size).toBe(0);
  });

  it("keeps image bytes out of localStorage and restores them after a reload", async () => {
    expect(composerAttachmentBytes).not.toBeNull();
    const first = loadStore();
    const image = imageFile("img-reload", "pixels");
    first.getState().setPrompt(threadRef, "Look at this");
    first.getState().addImage(threadRef, image);
    const persisted = await persistComposerImageBytes({ ...image, file: image.file! });
    expect(persisted).toMatchObject({ id: "img-reload", bytes: "local" });
    first.getState().syncPersistedAttachments(threadRef, [persisted!]);
    composerDraftWriteScheduler.flush();

    const entry = localStorage.getItem(composerDraftEntryStorageKey(threadKey))!;
    expect(entry).not.toContain("data:");
    expect(JSON.parse(entry).attachments).toEqual([persisted]);

    // A page load: rows come back without bytes, then the bytes load.
    const second = loadStore();
    const hydrated = second.getState().draftsByThreadKey[threadKey]!;
    expect(hydrated.prompt).toBe("Look at this");
    expect(hydrated.images[0]).toMatchObject({ id: "img-reload", file: null, bytesPending: true });
    await restoreComposerDraftAttachments({
      readDrafts: () => second.getState().draftsByThreadKey,
      restore: (key, restored) => second.getState().restoreDraftImages(key, restored),
      bytes: composerAttachmentBytes,
    });
    const restored = second.getState().draftsByThreadKey[threadKey]!.images[0]!;
    expect(restored.bytesPending).toBeUndefined();
    expect(await restored.file!.text()).toBe("pixels");
    expect(restored.previewUrl.startsWith("blob:")).toBe(true);
  });

  it("migrates the single legacy entry and moves its data URLs into IndexedDB", async () => {
    localStorage.setItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: COMPOSER_DRAFT_STORAGE_VERSION,
        state: {
          draftsByThreadKey: {
            [threadKey]: {
              prompt: "Legacy draft",
              attachments: [
                {
                  type: "image",
                  id: "img-legacy",
                  name: "legacy.png",
                  mimeType: "image/png",
                  sizeBytes: 6,
                  dataUrl: `data:image/png;base64,${btoa("legacy")}`,
                },
              ],
            },
          },
          draftThreadsByThreadKey: {},
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        },
      }),
    );
    const store = loadStore();
    expect(store.getState().draftsByThreadKey[threadKey]?.prompt).toBe("Legacy draft");
    await restoreComposerDraftAttachments({
      readDrafts: () => store.getState().draftsByThreadKey,
      restore: (key, restored) => store.getState().restoreDraftImages(key, restored),
      bytes: composerAttachmentBytes,
    });
    composerDraftWriteScheduler.flush();

    expect(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(COMPOSER_DRAFT_INDEX_STORAGE_KEY)!).state.draftKeys,
    ).toEqual([threadKey]);
    const entry = JSON.parse(localStorage.getItem(composerDraftEntryStorageKey(threadKey))!);
    expect(entry.prompt).toBe("Legacy draft");
    expect(entry.attachments[0]).toMatchObject({ id: "img-legacy", bytes: "local" });
    expect(entry.attachments[0].dataUrl).toBeUndefined();
    const bytes = await composerAttachmentBytes!.getMany(["img-legacy"]);
    expect(await bytes.get("img-legacy")!.text()).toBe("legacy");
    const image = store.getState().draftsByThreadKey[threadKey]!.images[0]!;
    expect(await image.file!.text()).toBe("legacy");
  });

  it("releases a removed image's bytes once its draft no longer references them", async () => {
    const store = loadStore();
    const image = imageFile("img-removed", "gone soon");
    store.getState().setPrompt(threadRef, "Draft");
    store.getState().addImage(threadRef, image);
    const persisted = await persistComposerImageBytes({ ...image, file: image.file! });
    store.getState().syncPersistedAttachments(threadRef, [persisted!]);
    composerDraftWriteScheduler.flush();
    expect((await composerAttachmentBytes!.getMany(["img-removed"])).size).toBe(1);

    store.getState().removeImage(threadRef, "img-removed");
    store.getState().syncPersistedAttachments(threadRef, []);
    composerDraftWriteScheduler.flush();
    await expect
      .poll(async () => (await composerAttachmentBytes!.getMany(["img-removed"])).size)
      .toBe(0);
  });
});
