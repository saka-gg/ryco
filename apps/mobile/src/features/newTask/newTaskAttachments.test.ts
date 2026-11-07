import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatFileUploadRecord } from "@ryco/client-runtime/state/composer";
import type { DraftComposerAttachment } from "../../lib/composerFiles";
import {
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
