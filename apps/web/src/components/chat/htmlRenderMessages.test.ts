import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetHtmlRenderMessagesForTests,
  answerHtmlRenderMessage,
  buildHtmlRenderQueuedMessage,
  readHtmlRenderMessageConfirmation,
  registerHtmlRenderMessageSender,
  requestHtmlRenderMessage,
} from "./htmlRenderMessages";

const THREAD = "environment-local:thread-1";
const OTHER_THREAD = "environment-local:thread-2";

afterEach(() => {
  __resetHtmlRenderMessagesForTests();
});

/** The id of the request waiting for the reader in `threadKey`, as the confirmation reads it. */
function waitingId(threadKey = THREAD): number {
  const request = readHtmlRenderMessageConfirmation(threadKey);
  if (request === null) throw new Error("No request is waiting.");
  return request.id;
}

describe("requestHtmlRenderMessage", () => {
  it("queues the text in the page's own thread only once the reader sends it", async () => {
    const send = vi.fn(async (_text: string) => undefined);
    const other = vi.fn(async (_text: string) => undefined);
    registerHtmlRenderMessageSender(THREAD, send);
    registerHtmlRenderMessageSender(OTHER_THREAD, other);
    let settled = false;
    const request = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" });
    void request.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(send).not.toHaveBeenCalled();

    // The confirmation shows exactly what is sent, in the page's own thread only.
    expect(readHtmlRenderMessageConfirmation(THREAD)).toMatchObject({ title: "Plan", text: "B" });
    expect(readHtmlRenderMessageConfirmation(OTHER_THREAD)).toBeNull();
    // A stale answer is ignored.
    answerHtmlRenderMessage(waitingId() - 1, "send");
    expect(send).not.toHaveBeenCalled();
    answerHtmlRenderMessage(waitingId(), "send");
    expect(readHtmlRenderMessageConfirmation(THREAD)).toBeNull();
    await expect(request).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith("B");
    expect(other).not.toHaveBeenCalled();
  });

  it("refuses a thread whose view is not open, and a second request while one waits", async () => {
    await expect(
      requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" }),
    ).rejects.toThrow("Open this page's thread to send its message.");

    registerHtmlRenderMessageSender(THREAD, async () => undefined);
    const first = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" });
    await expect(
      requestHtmlRenderMessage({ threadKey: THREAD, title: "Other", text: "C" }),
    ).rejects.toThrow("Another message is waiting for the reader to confirm it.");
    answerHtmlRenderMessage(waitingId(), "cancel");
    await expect(first).rejects.toThrow("You cancelled the message.");
  });

  it("rejects when the thread's view closes first, or the queue refuses the message", async () => {
    const unregister = registerHtmlRenderMessageSender(THREAD, async () => undefined);
    const closed = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" });
    unregister();
    await expect(closed).rejects.toThrow("The thread closed before you confirmed the message.");

    registerHtmlRenderMessageSender(THREAD, async () => {
      throw new Error("Commands are unavailable on this connection.");
    });
    const refused = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" });
    answerHtmlRenderMessage(waitingId(), "send");
    await expect(refused).rejects.toThrow("Commands are unavailable on this connection.");
  });
});

describe("buildHtmlRenderQueuedMessage", () => {
  it("queues the reader's text alone, with the composer's model and the thread's modes", () => {
    const selection = {
      selectedProvider: ProviderDriverKind.make("claudeAgent"),
      selectedModel: "claude-opus-5-5",
      selectedProviderModels: [],
      selectedPromptEffort: "high",
      selectedModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-5-5",
      },
    };
    const entry = buildHtmlRenderQueuedMessage({
      id: "message-1",
      createdAt: "2026-10-31T00:00:00.000Z",
      text: "Option B",
      selection: { ...selection, prompt: "the draft the reader is writing" } as typeof selection,
      settings: { runtimeMode: "full-access", interactionMode: "default", tokenMode: "off" },
    });
    expect(entry).toEqual({
      id: "message-1",
      createdAt: "2026-10-31T00:00:00.000Z",
      composer: {
        prompt: "Option B",
        trimmedPrompt: "Option B",
        images: [],
        sendableTerminalContexts: [],
        fileReferences: [],
        sourceControlContexts: [],
        ...selection,
        expiredTerminalContextCount: 0,
      },
      settings: { runtimeMode: "full-access", interactionMode: "default", tokenMode: "off" },
    });
  });
});
