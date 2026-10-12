import { describe, expect, it } from "vite-plus/test";

import {
  composerFileUploadEngine,
  deriveComposerFileUploadSendBlock,
  releaseUnusedComposerFileUploads,
  seedComposerFileNeedsReattach,
  seedComposerFileUploadFromPersisted,
} from "./composerFileUpload";

const NOW = Date.now();

function releaseSeeded(ids: readonly string[]): void {
  for (const id of ids) {
    composerFileUploadEngine.release(id);
  }
}

describe("deriveComposerFileUploadSendBlock", () => {
  it("blocks byte-less files without a record", () => {
    expect(
      deriveComposerFileUploadSendBlock({
        attachments: [{ id: "a", type: "file", name: "orphan.bin", file: null }],
        nowMs: NOW,
      }),
    ).toContain("Attach 'orphan.bin' again");
  });

  it("allows byte-less files carrying a still-valid token", () => {
    const seeded = ["a"];
    try {
      seedComposerFileNeedsReattach("a");
      composerFileUploadEngine.release("a");
      expect(
        deriveComposerFileUploadSendBlock({
          attachments: [
            {
              id: "a",
              type: "file",
              name: "restored.bin",
              file: null,
              uploadToken: "tok",
              expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
            },
          ],
          nowMs: NOW,
        }),
      ).toBeNull();
    } finally {
      releaseSeeded(seeded);
    }
  });

  it("blocks failed uploads with a retry hint and lets uploads pass", () => {
    const seeded = ["a", "b", "c"];
    try {
      seedComposerFileNeedsReattach("a");
      expect(
        deriveComposerFileUploadSendBlock({
          attachments: [{ id: "a", type: "file", name: "slow.bin", file: null }],
          nowMs: NOW,
        }),
      ).toContain("Attach 'slow.bin' again");

      seedComposerFileUploadFromPersisted({
        attachmentId: "b",
        name: "done.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        uploadToken: "tok",
        expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      });
      expect(
        deriveComposerFileUploadSendBlock({
          attachments: [{ id: "b", type: "file", name: "done.bin", file: null }],
          nowMs: NOW,
        }),
      ).toBeNull();

      seedComposerFileUploadFromPersisted({
        attachmentId: "c",
        name: "stale.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        uploadToken: "tok",
        expiresAt: new Date(NOW - 10 * 60_000).toISOString(),
      });
      expect(
        deriveComposerFileUploadSendBlock({
          attachments: [{ id: "c", type: "file", name: "stale.bin", file: null }],
          nowMs: NOW,
        }),
      ).toContain("Attach 'stale.bin' again");
    } finally {
      releaseSeeded(seeded);
    }
  });

  it("judges against the records snapshot a render subscribed to", () => {
    const seeded = ["snap"];
    try {
      seedComposerFileUploadFromPersisted({
        attachmentId: "snap",
        name: "snap.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        uploadToken: "tok",
        expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      });
      const uploadedSnapshot = composerFileUploadEngine.snapshot();
      const attachments = [{ id: "snap", type: "file", name: "snap.bin", file: null }];
      expect(
        deriveComposerFileUploadSendBlock({ attachments, nowMs: NOW, records: uploadedSnapshot }),
      ).toBeNull();

      composerFileUploadEngine.release("snap");
      seedComposerFileNeedsReattach("snap");
      // The passed snapshot wins over the live engine, so a memoized render
      // only changes its answer when it receives a new snapshot.
      expect(
        deriveComposerFileUploadSendBlock({ attachments, nowMs: NOW, records: uploadedSnapshot }),
      ).toBeNull();
      expect(
        deriveComposerFileUploadSendBlock({
          attachments,
          nowMs: NOW,
          records: composerFileUploadEngine.snapshot(),
        }),
      ).toContain("Attach 'snap.bin' again");
      expect(
        deriveComposerFileUploadSendBlock({
          attachments,
          nowMs: NOW,
          records: new Map(),
        }),
      ).toContain("Attach 'snap.bin' again");
    } finally {
      releaseSeeded(seeded);
    }
  });
});

describe("composer upload cleanup", () => {
  it("releases removed rows while retaining hidden drafts and uploads owned by another composer", () => {
    const ids = ["removed", "hidden-draft", "other-composer"];
    try {
      for (const id of ids) seedComposerFileNeedsReattach(id);
      releaseUnusedComposerFileUploads(
        new Set(["removed", "hidden-draft"]),
        new Set(["hidden-draft"]),
      );
      expect(composerFileUploadEngine.get("removed")).toBeNull();
      expect(composerFileUploadEngine.get("hidden-draft")).not.toBeNull();
      expect(composerFileUploadEngine.get("other-composer")).not.toBeNull();
    } finally {
      releaseSeeded(ids);
    }
  });
});
