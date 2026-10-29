import type { MessageId, QueuedFollowUp } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { clearCancelledServerQueueEdit, serverQueueEditOf } from "./serverQueueEdit";

describe("editing the node's entry on the thread screen", () => {
  it("edits at the revision shown, keeping the entry's stored attachments by id", () => {
    expect(
      serverQueueEditOf("env:t", {
        messageId: "m-1" as MessageId,
        revision: 3,
        attachments: [
          { type: "image", id: "img-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ] as QueuedFollowUp["attachments"],
      }),
    ).toEqual({ threadKey: "env:t", messageId: "m-1", revision: 3, keptAttachmentIds: ["img-1"] });
  });

  it("clears the text and the attachments added during the edit when it is cancelled", () => {
    const composer = {
      setText: vi.fn(),
      setAttachments: vi.fn(),
      setAttachmentError: vi.fn(),
    };
    clearCancelledServerQueueEdit(composer);
    expect(composer.setText).toHaveBeenCalledWith("");
    expect(composer.setAttachments).toHaveBeenCalledWith([]);
    expect(composer.setAttachmentError).toHaveBeenCalledWith(null);
  });
});
