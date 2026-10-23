import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerContentWithReturnedMessage, loadSentMessageFiles } from "./editFromHere";

const ENVIRONMENT_ID = EnvironmentId.make("environment-edit");
const THREAD_ID = ThreadId.make("thread-edit");

const sentMessage = {
  id: MessageId.make("message-edit"),
  text: "Ultrathink:\nSplit the auth module",
  attachments: [
    {
      type: "file" as const,
      id: "attachment-notes",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    },
    { type: "audio" as never, id: "attachment-unknown" },
  ],
};

describe("loadSentMessageFiles", () => {
  it("reads the attachments before anything is reverted", async () => {
    const readBytes = vi.fn(async () => new Uint8Array([97, 98, 99]));
    const returned = await loadSentMessageFiles({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      message: sentMessage as never,
      composerAttachments: [],
      readBytes,
    });

    // As sent: the prefix is what selects ultrathink again.
    expect(returned.prompt).toBe("Ultrathink:\nSplit the auth module");
    expect(returned.attachments.map((file) => [file.name, file.type, file.size])).toEqual([
      ["notes.txt", "text/plain", 3],
    ]);
    expect(readBytes).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      messageId: sentMessage.id,
      attachmentId: "attachment-notes",
      sizeBytes: 3,
    });
  });

  it("refuses when the attachments cannot be read or do not fit", async () => {
    await expect(
      loadSentMessageFiles({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        message: sentMessage as never,
        composerAttachments: [],
        readBytes: async () => {
          throw new Error("Attachment connection unavailable.");
        },
      }),
    ).rejects.toThrow("Couldn't load this message's attachments, so nothing was reverted.");

    const readBytes = vi.fn(async () => new Uint8Array(3));
    await expect(
      loadSentMessageFiles({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        message: sentMessage as never,
        composerAttachments: Array.from({ length: 8 }, () => ({ sizeBytes: 1 })),
        readBytes,
      }),
    ).rejects.toThrow("Remove some attachments from the composer first");
    expect(readBytes).not.toHaveBeenCalled();
  });
});

describe("composerContentWithReturnedMessage", () => {
  it("puts the prompt below the unsent draft and attaches each file again", () => {
    const file = new File([new Uint8Array([1, 2])], "notes.txt", { type: "text/plain" });
    const content = composerContentWithReturnedMessage({
      returned: { prompt: "Split the auth module", attachments: [file] },
      draftPrompt: "Unsent idea",
      environmentId: ENVIRONMENT_ID,
      uploadThreadId: null,
    });

    expect(content.prompt).toBe("Unsent idea\n\nSplit the auth module");
    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0]).toMatchObject({
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      previewUrl: "",
      file,
    });
  });
});
