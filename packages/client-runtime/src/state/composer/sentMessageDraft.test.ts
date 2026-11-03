import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@ryco/contracts/orchestration";
import { describe, expect, it, vi } from "vite-plus/test";

import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./sendEngine.ts";
import {
  appendReturnedComposerPrompt,
  composerPromptFromSentMessage,
  loadReturnedSentMessage,
  returnableSentAttachments,
  returnedAttachmentsOverflow,
} from "./sentMessageDraft.ts";
import { appendTerminalContextsToPrompt } from "./terminalContext.ts";

describe("composerPromptFromSentMessage", () => {
  it("returns the text as it was sent, so a resend says the same", () => {
    expect(composerPromptFromSentMessage(" Fix the login bug\n")).toBe("Fix the login bug");
    // The prefix is what selects ultrathink in the composer.
    expect(composerPromptFromSentMessage("Ultrathink:\nFix the login bug")).toBe(
      "Ultrathink:\nFix the login bug",
    );
    expect(composerPromptFromSentMessage(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
  });

  it("keeps attached terminal output, which the revert would otherwise lose", () => {
    const withContext = appendTerminalContextsToPrompt("Why does this fail?", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "a\nb",
      },
    ]);
    expect(withContext).toContain("<terminal_context>");
    expect(composerPromptFromSentMessage(withContext)).toBe(withContext);
  });
});

describe("appendReturnedComposerPrompt", () => {
  it("keeps the unsent draft first", () => {
    expect(appendReturnedComposerPrompt("", "Returned")).toBe("Returned");
    expect(appendReturnedComposerPrompt("  \n", "Returned")).toBe("Returned");
    expect(appendReturnedComposerPrompt("Draft\n", "Returned")).toBe("Draft\n\nReturned");
    expect(appendReturnedComposerPrompt("Draft", "")).toBe("Draft");
  });
});

describe("returnableSentAttachments", () => {
  it("keeps images and files only", () => {
    const image = {
      type: "image" as const,
      id: "a",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const file = {
      type: "file" as const,
      id: "b",
      name: "b.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    };
    expect(returnableSentAttachments([image, { type: "audio" }, file] as never)).toEqual([
      image,
      file,
    ]);
    expect(returnableSentAttachments(undefined)).toEqual([]);
  });
});

describe("returnedAttachmentsOverflow", () => {
  const one = { sizeBytes: 1 };
  it("refuses more attachments or bytes than one message can carry", () => {
    expect(returnedAttachmentsOverflow({ existing: [], returned: [] })).toBeNull();
    expect(returnedAttachmentsOverflow({ existing: [one], returned: [one] })).toBeNull();
    expect(
      returnedAttachmentsOverflow({
        existing: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () => one),
        returned: [one],
      }),
    ).toContain("Remove some attachments");
    expect(
      returnedAttachmentsOverflow({
        existing: [{ sizeBytes: PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES }],
        returned: [one],
      }),
    ).toContain("Remove some attachments");
  });
});

describe("loadReturnedSentMessage", () => {
  const image = {
    type: "image" as const,
    id: "image-1",
    name: "sketch.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  const file = {
    type: "file" as const,
    id: "file-1",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
  };
  const message = { text: "Split the auth module", attachments: [image, file] };

  it("loads each attachment in order, one at a time", async () => {
    const order: string[] = [];
    let running = 0;
    const returned = await loadReturnedSentMessage({
      message,
      composerAttachments: [],
      load: async (attachment) => {
        running += 1;
        expect(running).toBe(1);
        order.push(attachment.id);
        await Promise.resolve();
        running -= 1;
        return attachment.name;
      },
    });

    expect(returned).toEqual({
      prompt: "Split the auth module",
      attachments: ["sketch.png", "notes.txt"],
    });
    expect(order).toEqual(["image-1", "file-1"]);
  });

  it("refuses before loading anything when the attachments cannot come back", async () => {
    const load = vi.fn(async () => "loaded");
    await expect(
      loadReturnedSentMessage({
        message,
        composerAttachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () => ({
          sizeBytes: 1,
        })),
        load,
      }),
    ).rejects.toThrow("Remove some attachments from the composer first");
    await expect(
      loadReturnedSentMessage({
        message,
        composerAttachments: [],
        refuse: (attachments) =>
          attachments.some((attachment) => attachment.type === "file") ? "No files here." : null,
        load,
      }),
    ).rejects.toThrow("No files here.");
    expect(load).not.toHaveBeenCalled();

    await expect(
      loadReturnedSentMessage({
        message,
        composerAttachments: [],
        load: async () => {
          throw new Error("Attachment connection unavailable.");
        },
      }),
    ).rejects.toThrow("Couldn't load this message's attachments, so nothing was reverted.");
  });

  it("asks nothing of a message without attachments", async () => {
    const refuse = vi.fn(() => "No files here.");
    await expect(
      loadReturnedSentMessage({
        message: { text: "Just text" },
        composerAttachments: [],
        refuse,
        load: async () => "loaded",
      }),
    ).resolves.toEqual({ prompt: "Just text", attachments: [] });
    expect(refuse).not.toHaveBeenCalled();
  });
});
