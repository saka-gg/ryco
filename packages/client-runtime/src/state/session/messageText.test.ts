import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadWholeMessageText, MESSAGE_TEXT_PREVIEW_COPY } from "./messageText.ts";

const environmentId = "env-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const messageId = "message-1" as MessageId;

const result = (text: string, truncated = false) => ({
  messageId,
  text,
  fullLength: truncated ? text.length * 2 : text.length,
  truncated,
});

describe("loadWholeMessageText", () => {
  it("reads the whole text once for concurrent requests and puts it into the store", async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    const read = vi.fn(() => new Promise<ReturnType<typeof result>>((done) => (resolve = done)));
    const apply = vi.fn();
    const first = loadWholeMessageText({ environmentId, threadId, messageId, read, apply });
    const second = loadWholeMessageText({ environmentId, threadId, messageId, read, apply });
    resolve(result("the whole text"));
    await expect(first).resolves.toMatchObject({ text: "the whole text" });
    await expect(second).resolves.toMatchObject({ text: "the whole text" });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ threadId, messageId });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith("the whole text");

    // A finished read is not served again.
    read.mockImplementation(() => Promise.resolve(result("again")));
    await loadWholeMessageText({ environmentId, threadId, messageId, read, apply });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a text still cut short as a preview", async () => {
    const apply = vi.fn();
    const loaded = await loadWholeMessageText({
      environmentId,
      threadId,
      messageId,
      read: () => Promise.resolve(result("first million", true)),
      apply,
    });
    expect(loaded.truncated).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects when the read fails or the environment cannot read, and retries afresh", async () => {
    const apply = vi.fn();
    const read = vi.fn(() => Promise.reject(new Error("relay dropped")));
    await expect(
      loadWholeMessageText({ environmentId, threadId, messageId, read, apply }),
    ).rejects.toThrow("relay dropped");
    read.mockImplementation(() => Promise.resolve(result("whole")) as never);
    await expect(
      loadWholeMessageText({ environmentId, threadId, messageId, read, apply }),
    ).resolves.toMatchObject({ text: "whole" });
    await expect(
      loadWholeMessageText({ environmentId, threadId, messageId, read: undefined, apply }),
    ).rejects.toThrow("cannot load the whole message");
  });

  it("labels the control with the whole length", () => {
    expect(MESSAGE_TEXT_PREVIEW_COPY.show(48_000)).toBe("Show whole message (48,000 characters)");
  });
});
