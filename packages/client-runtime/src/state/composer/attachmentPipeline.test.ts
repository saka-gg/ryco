import { describe, expect, it } from "vite-plus/test";

import type { ComposerAttachment } from "../../platform/index.ts";
import { createMessageQueueStore } from "../message-queue/index.ts";
import { buildSendTurnDispatchAttachment, encodeComposerAttachmentDataUrl } from "./sendEngine.ts";

// Attachment pipeline: compose -> queue -> send, driven entirely through the
// neutral `ComposerAttachment` union so the package path never touches a DOM
// `File`. Exercises both discriminants of the flat union.

interface ComposerSnapshot {
  readonly attachments: ReadonlyArray<{
    readonly attachment: ComposerAttachment;
    readonly name: string;
    readonly type?: "image" | "file";
  }>;
}

const bytesBacked: ComposerAttachment = {
  id: "img-bytes",
  mime: "image/png",
  size: 3,
  bytes: new Uint8Array([1, 2, 3]),
};

const uriBacked: ComposerAttachment = {
  id: "img-uri",
  mime: "image/jpeg",
  size: 12,
  uri: "data:image/jpeg;base64,QUJD",
};

const fileBacked: ComposerAttachment = {
  id: "file-bytes",
  mime: "text/plain",
  size: 3,
  bytes: new Uint8Array([97, 98, 99]),
};

describe("composer attachment pipeline (compose -> queue -> send)", () => {
  it("carries neutral attachments through the queue and encodes both union variants on send", () => {
    // compose: the codec-produced union is the runtime carrier (no File).
    const snapshot: ComposerSnapshot = {
      attachments: [
        { attachment: bytesBacked, name: "diagram.png" },
        { attachment: uriBacked, name: "photo.jpg" },
        { attachment: fileBacked, name: "notes.txt", type: "file" },
      ],
    };

    // queue: the message-queue store holds the union-backed snapshot as state.
    const useQueue = createMessageQueueStore<ComposerSnapshot, { readonly runtimeMode: string }>();
    useQueue.getState().enqueue("thread-a", {
      id: "queued-1",
      composer: snapshot,
      settings: { runtimeMode: "full-access" },
    });

    const queued = useQueue.getState().queuesByThreadKey["thread-a"]?.[0];
    expect(queued?.composer.attachments.map((entry) => entry.attachment.id)).toEqual([
      "img-bytes",
      "img-uri",
      "file-bytes",
    ]);

    // send: the package builds outgoing turn attachments from the union alone.
    const dispatched = queued!.composer.attachments.map((entry) =>
      buildSendTurnDispatchAttachment({
        attachment: entry.attachment,
        name: entry.name,
        ...(entry.type ? { type: entry.type } : {}),
      }),
    );

    expect(dispatched[0]).toEqual({
      type: "image",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
    });
    expect(dispatched[1]).toEqual({
      type: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12,
      dataUrl: "data:image/jpeg;base64,QUJD",
    });
    expect(dispatched[2]).toEqual({
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      dataUrl: "data:text/plain;base64,YWJj",
    });
  });

  it("encodes bytes to a base64 data URL and passes a uri-backed attachment through", () => {
    expect(encodeComposerAttachmentDataUrl(bytesBacked)).toBe("data:image/png;base64,AQID");
    expect(encodeComposerAttachmentDataUrl(uriBacked)).toBe("data:image/jpeg;base64,QUJD");
  });
});
