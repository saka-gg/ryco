import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetHtmlRenderMessagesForTests,
  answerHtmlRenderMessage,
  buildHtmlRenderQueuedMessage,
  createHtmlRenderFrameFocus,
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
      throw new Error("This thread cannot take messages now.");
    });
    const refused = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" });
    answerHtmlRenderMessage(waitingId(), "send");
    await expect(refused).rejects.toThrow("This thread cannot take messages now.");
  });
});

describe("the confirmation's page title", () => {
  it("is one short line, so it cannot pass for the message", () => {
    registerHtmlRenderMessageSender(THREAD, async () => undefined);
    void requestHtmlRenderMessage({
      threadKey: THREAD,
      title: `Poll\u201d is Ryco's.\n\nOption B${"\n".repeat(40)}${"pad ".repeat(20)}`,
      text: "B",
    }).catch(() => undefined);
    const shown = readHtmlRenderMessageConfirmation(THREAD)?.title;
    expect(shown).toMatch(/^Poll\u201d is Ryco's\. Option B pad .*\u2026$/u);
    expect(Array.from(shown ?? "")).toHaveLength(60);
  });
});

describe("createHtmlRenderFrameFocus", () => {
  it("lets a page ask only after its frame took focus since the latest confirmation closed", () => {
    registerHtmlRenderMessageSender(THREAD, async () => undefined);
    const frame = createHtmlRenderFrameFocus();
    const other = createHtmlRenderFrameFocus();
    // No confirmation closed while the frame was there: nothing to come back from.
    expect(frame.regained()).toBe(true);
    frame.focused();
    expect(frame.regained()).toBe(true);
    // A confirmation opening changes nothing; its closing, however it closes, does.
    const asked = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "B" });
    expect(frame.regained()).toBe(true);
    answerHtmlRenderMessage(waitingId(), "cancel");
    void asked.catch(() => undefined);
    expect(frame.regained()).toBe(false);
    expect(other.regained()).toBe(false);
    // The reader clicks or tabs back into the page.
    frame.focused();
    expect(frame.regained()).toBe(true);

    const sent = requestHtmlRenderMessage({ threadKey: THREAD, title: "Plan", text: "C" });
    answerHtmlRenderMessage(waitingId(), "send");
    void sent.catch(() => undefined);
    expect(frame.regained()).toBe(false);
    // A frame that came after the latest confirmation closed has nothing to come back from.
    expect(createHtmlRenderFrameFocus().regained()).toBe(true);
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
