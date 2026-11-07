import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatFileUploadRecord } from "@ryco/client-runtime/state/composer";
import type { DraftComposerAttachment } from "../../lib/composerFiles";
import {
  admitDraftAttachments,
  NEW_TASK_QUEUED_FILES_BLOCK,
  newTaskAttachmentSendBlock,
  newTaskDraftImages,
  toNewTaskDispatchAttachments,
} from "./newTaskAttachments";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const image: DraftComposerAttachment = {
  type: "image",
  id: "img",
  name: "a.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,AAA",
  previewUri: "file:///a.png",
};
const file: DraftComposerAttachment = {
  type: "file",
  id: "pdf",
  name: "b.pdf",
  mimeType: "application/pdf",
  sizeBytes: 9,
  readUri: "file:///b.pdf",
};

function record(status: ChatFileUploadRecord["status"]): ChatFileUploadRecord {
  return {
    attachmentId: "pdf",
    threadId: "t" as ThreadId,
    environmentId: "e" as EnvironmentId,
    name: "b.pdf",
    mimeType: "application/pdf",
    sizeBytes: 9,
    readBytes: () => new Uint8Array(),
    status,
  };
}
const uploaded = record({
  kind: "uploaded",
  uploadToken: "tok",
  expiresAt: "2026-11-07T13:00:00Z",
});

describe("newTaskAttachmentSendBlock", () => {
  it("does not block photos, and blocks files while they upload", () => {
    const base = { getRecord: () => null, queueing: false, nowMs: NOW };
    expect(newTaskAttachmentSendBlock({ ...base, attachments: [image] })).toBeNull();
    expect(
      newTaskAttachmentSendBlock({
        ...base,
        attachments: [image, file],
        getRecord: () => record({ kind: "uploading", progress: 0.5 }),
      }),
    ).toBe("Uploading 'b.pdf'…");
    expect(
      newTaskAttachmentSendBlock({ ...base, attachments: [file], getRecord: () => uploaded }),
    ).toBeNull();
  });

  it("keeps files out of a task that waits for its machine", () => {
    expect(
      newTaskAttachmentSendBlock({
        attachments: [file],
        getRecord: () => uploaded,
        queueing: true,
        nowMs: NOW,
      }),
    ).toBe(NEW_TASK_QUEUED_FILES_BLOCK);
  });
});

describe("toNewTaskDispatchAttachments", () => {
  it("sends photos inline and files by their upload token", () => {
    expect(
      toNewTaskDispatchAttachments({
        attachments: [image, file],
        getRecord: () => uploaded,
        nowMs: NOW,
      }),
    ).toEqual([
      { type: "image", name: "a.png", mimeType: "image/png", sizeBytes: 3, dataUrl: image.dataUrl },
      {
        type: "file",
        name: "b.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
        uploadToken: "tok",
      },
    ]);
  });

  it("refuses a file without a fresh upload", () => {
    expect(() =>
      toNewTaskDispatchAttachments({ attachments: [file], getRecord: () => null, nowMs: NOW }),
    ).toThrow("Attach 'b.pdf' again");
  });
});

describe("newTaskDraftImages", () => {
  it("keeps only the photos", () => {
    expect(newTaskDraftImages([image, file]).map((entry) => entry.id)).toEqual(["img"]);
  });
});

describe("admitDraftAttachments", () => {
  const MB = 1024 * 1024;
  const fileOf = (id: string, sizeBytes: number): DraftComposerAttachment => ({
    ...file,
    id,
    name: `${id}.bin`,
    sizeBytes,
  });

  it("keeps shared files within the draft's count and total size", () => {
    const existing = Array.from({ length: 6 }, (_, index) => fileOf(`old${index}`, MB));
    const result = admitDraftAttachments({
      existing,
      incoming: [fileOf("a", MB), fileOf("b", MB), fileOf("c", MB)],
      fileUploadMaxBytes: 50 * MB,
    });
    expect(result.accepted.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result.rejected.map((entry) => entry.id)).toEqual(["c"]);
    expect(result.warnings).toEqual(["You can attach up to 8 files per message."]);

    const big = admitDraftAttachments({
      existing: [],
      incoming: [fileOf("x", 30 * MB), fileOf("y", 30 * MB)],
      fileUploadMaxBytes: 50 * MB,
    });
    expect(big.accepted.map((entry) => entry.id)).toEqual(["x"]);
    expect(big.warnings).toEqual(["Attachments can total at most 50MB per message."]);
  });

  it("refuses streamed files for a node that does not take them, but keeps photos", () => {
    const result = admitDraftAttachments({
      existing: [],
      incoming: [image, file],
      fileUploadMaxBytes: null,
    });
    expect(result.accepted).toEqual([image]);
    expect(result.rejected).toEqual([file]);
    expect(result.warnings[0]).toContain("only takes images");
  });

  it("holds files to the node's own upload limit", () => {
    const result = admitDraftAttachments({
      existing: [],
      incoming: [fileOf("x", 20 * MB)],
      fileUploadMaxBytes: 10 * MB,
    });
    expect(result.rejected.map((entry) => entry.id)).toEqual(["x"]);
  });
});
