import type { PersistedComposerImageAttachment } from "@ryco/client-runtime/state/composer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerAttachmentBytesStore } from "./composerAttachmentBytes";
import type { ComposerImageAttachment } from "./composerDraftStore";

import {
  composerFileUploadEngine,
  seedComposerFileNeedsReattach,
  seedComposerFileUploadFromPersisted,
} from "./composerFileUpload";
import {
  collectComposerAttachmentBytes,
  hydrateDraftImagesFromPersisted,
  hydrateImagesFromPersistedWithFailures,
  resetComposerAttachmentRestoreForTests,
  restoreComposerDraftAttachments,
} from "./composerDraftPersistence";

function releaseSeeded(ids: readonly string[]): void {
  for (const id of ids) {
    composerFileUploadEngine.release(id);
  }
}

describe("hydrateImagesFromPersistedWithFailures — streamed file attachments", () => {
  it("restores uploaded files from token metadata and seeds the engine", () => {
    const seeded = ["file-token-1"];
    try {
      const { images, unreadableImageNames } = hydrateImagesFromPersistedWithFailures([
        {
          type: "file",
          id: "file-token-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          uploadToken: "upload-token-1",
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      ]);

      expect(unreadableImageNames).toEqual([]);
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({
        type: "file",
        id: "file-token-1",
        name: "report.pdf",
        file: null,
        previewUrl: "",
      });
      const status = composerFileUploadEngine.get("file-token-1")?.status;
      expect(status?.kind).toBe("uploaded");
    } finally {
      releaseSeeded(seeded);
    }
  });

  it("restores interrupted uploads as needsReattach rows", () => {
    const seeded = ["file-pending-1"];
    try {
      const { images } = hydrateImagesFromPersistedWithFailures([
        {
          type: "file",
          id: "file-pending-1",
          name: "video.mov",
          mimeType: "video/quicktime",
          sizeBytes: 4096,
          uploadState: "needsReattach",
        },
      ]);
      expect(images[0]).toMatchObject({
        type: "file",
        id: "file-pending-1",
        name: "video.mov",
        file: null,
      });
      expect(composerFileUploadEngine.get("file-pending-1")?.status.kind).toBe("needsReattach");
    } finally {
      releaseSeeded(seeded);
    }
  });

  it("still decodes dataUrl attachments and flags unreadable ones", () => {
    const { images, unreadableImageNames } = hydrateImagesFromPersistedWithFailures([
      {
        type: "image",
        id: "img-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
      {
        type: "file",
        id: "img-2",
        name: "broken.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 4,
        dataUrl: "data:application/octet-stream;base64,!!!!",
      },
    ]);
    expect(unreadableImageNames).toEqual(["broken.bin"]);
    expect(images).toHaveLength(1);
    expect(images[0]?.file).toBeInstanceOf(File);
  });

  it("seed helpers demote expired tokens and skip uploaded records", () => {
    const seeded = ["seed-expired", "seed-live"];
    try {
      seedComposerFileUploadFromPersisted({
        attachmentId: "seed-expired",
        name: "old.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        uploadToken: "tok",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(composerFileUploadEngine.get("seed-expired")?.status.kind).toBe("needsReattach");

      seedComposerFileUploadFromPersisted({
        attachmentId: "seed-live",
        name: "new.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        uploadToken: "tok",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      seedComposerFileNeedsReattach("seed-live");
      expect(composerFileUploadEngine.get("seed-live")?.status.kind).toBe("uploaded");
    } finally {
      releaseSeeded(seeded);
    }
  });
});

function memoryBytesStore(initial: Record<string, Blob> = {}) {
  const blobs = new Map(Object.entries(initial));
  const store: ComposerAttachmentBytesStore = {
    put: vi.fn(async (id: string, blob: Blob) => {
      blobs.set(id, blob);
    }),
    getMany: vi.fn(
      async (ids: ReadonlyArray<string>) =>
        new Map(ids.flatMap((id) => (blobs.has(id) ? [[id, blobs.get(id)!] as const] : []))),
    ),
    deleteMany: vi.fn(async (ids: ReadonlyArray<string>) => {
      for (const id of ids) blobs.delete(id);
    }),
    deleteUnreferenced: vi.fn(async (keep: ReadonlySet<string>) => {
      let deleted = 0;
      for (const id of blobs.keys()) {
        if (!keep.has(id)) {
          blobs.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    }),
  };
  return { store, blobs };
}

const localAttachment = (id: string): PersistedComposerImageAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 3,
  bytes: "local",
});

describe("draft attachment restore", () => {
  afterEach(() => resetComposerAttachmentRestoreForTests());

  it("hydrates rows without reading or decoding any bytes", () => {
    const atob = vi.spyOn(globalThis, "atob");
    try {
      const images = hydrateDraftImagesFromPersisted([
        localAttachment("local-1"),
        {
          type: "image",
          id: "legacy-1",
          name: "legacy.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: "data:image/png;base64,AAAA",
        },
      ]);
      expect(atob).not.toHaveBeenCalled();
      expect(
        images.map((image) => [image.id, image.file, image.bytesPending, image.previewUrl]),
      ).toEqual([
        ["local-1", null, true, ""],
        ["legacy-1", null, true, "data:image/png;base64,AAAA"],
      ]);
    } finally {
      atob.mockRestore();
    }
  });

  it("loads stored bytes, moves legacy data URLs into the store, and drops missing ones", async () => {
    const { store, blobs } = memoryBytesStore({
      "local-1": new Blob(["abc"], { type: "image/png" }),
    });
    const legacy: PersistedComposerImageAttachment = {
      type: "image",
      id: "legacy-1",
      name: "legacy.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
    };
    const attachments = [localAttachment("local-1"), legacy, localAttachment("gone-1")];
    const draft = {
      images: hydrateDraftImagesFromPersisted(attachments),
      persistedAttachments: attachments,
    };
    const restore = vi.fn();
    await restoreComposerDraftAttachments({
      readDrafts: () => ({ "thread-key": draft }),
      restore,
      bytes: store,
      createObjectUrl: (blob) => `blob:${blob.size}`,
    });

    expect(restore).toHaveBeenCalledTimes(1);
    const [threadKey, restored] = restore.mock.calls[0] as [
      string,
      Array<{
        id: string;
        image: ComposerImageAttachment | null;
        persisted?: PersistedComposerImageAttachment;
      }>,
    ];
    expect(threadKey).toBe("thread-key");
    const byId = new Map(restored.map((entry) => [entry.id, entry]));
    expect(await byId.get("local-1")!.image!.file!.text()).toBe("abc");
    expect(byId.get("local-1")!.image!.bytesPending).toBeUndefined();
    expect(byId.get("local-1")!.image!.previewUrl).toBe("blob:3");
    expect(byId.get("local-1")!.persisted).toBeUndefined();
    // The legacy data URL now lives in the store and the record sheds it.
    expect(await byId.get("legacy-1")!.image!.file!.text()).toBe("abc");
    expect(byId.get("legacy-1")!.persisted).toEqual({
      ...localAttachment("legacy-1"),
      name: "legacy.png",
    });
    expect(blobs.has("legacy-1")).toBe(true);
    expect(byId.get("gone-1")!.image).toBeNull();
  });

  it("leaves images pending when the store cannot be read, so a later call retries", async () => {
    const { store } = memoryBytesStore();
    vi.mocked(store.getMany).mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    const draft = {
      images: hydrateDraftImagesFromPersisted([localAttachment("local-1")]),
      persistedAttachments: [localAttachment("local-1")],
    };
    const restore = vi.fn();
    const input = { readDrafts: () => ({ key: draft }), restore, bytes: store };
    await restoreComposerDraftAttachments(input);
    expect(restore).not.toHaveBeenCalled();
    await restoreComposerDraftAttachments(input);
    expect(restore).toHaveBeenCalledWith("key", [{ id: "local-1", image: null }]);
  });

  it("collects only bytes no draft references", async () => {
    const { store, blobs } = memoryBytesStore({
      kept: new Blob(["k"]),
      orphan: new Blob(["o"]),
    });
    const deleted = await collectComposerAttachmentBytes({
      readDrafts: () => ({
        key: { images: [], persistedAttachments: [localAttachment("kept")] },
      }),
      bytes: store,
    });
    expect(deleted).toBe(1);
    expect([...blobs.keys()]).toEqual(["kept"]);
  });
});
