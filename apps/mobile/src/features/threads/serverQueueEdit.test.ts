import { describe, expect, it, vi } from "vite-plus/test";

import { clearCancelledServerQueueEdit } from "./serverQueueEdit";

describe("editing the node's entry on the thread screen", () => {
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
