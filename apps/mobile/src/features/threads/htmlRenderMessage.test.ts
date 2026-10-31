import { CommandId, EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildHtmlRenderOutboxMessage,
  createHtmlRenderMessageDelivery,
  type HtmlRenderMessageConfirmRequest,
} from "./htmlRenderMessage";

function setup(queue: (text: string) => void = () => undefined) {
  const dialogs: HtmlRenderMessageConfirmRequest[] = [];
  const queued = vi.fn(queue);
  const clock = { now: 50_000 };
  const deliver = createHtmlRenderMessageDelivery({
    pageTitle: "Pick a plan",
    // Each dialog is answered a reader's while after it appears, unless a test says otherwise.
    confirm: (request) => {
      dialogs.push(request);
      clock.now += 2_000;
    },
    queue: queued,
    now: () => clock.now,
  });
  return { deliver, dialogs, queued, clock };
}

describe("createHtmlRenderMessageDelivery", () => {
  it("shows the reader the page and the exact text, and queues it only on Send", async () => {
    const { deliver, dialogs, queued } = setup();
    const sent = deliver("Option B\nwith notes");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({
      title: "Send this message?",
      cancelText: "Cancel",
      confirmText: "Send",
    });
    expect(dialogs[0]!.message).toContain("“Pick a plan”");
    expect(dialogs[0]!.message.endsWith("\n\nOption B\nwith notes")).toBe(true);
    expect(queued).not.toHaveBeenCalled();

    dialogs[0]!.onConfirm();
    await expect(sent).resolves.toBeUndefined();
    expect(queued).toHaveBeenCalledExactlyOnceWith("Option B\nwith notes");
    // A second answer of the same dialog changes nothing.
    dialogs[0]!.onConfirm();
    dialogs[0]!.onCancel();
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("asks again when Send comes too soon after the dialog appeared", async () => {
    const { deliver, dialogs, queued, clock } = setup();
    const sent = deliver("Option B");
    // The page's double tap lands on Send as it appears.
    clock.now -= 2_000;
    clock.now += 300;
    dialogs[0]!.onConfirm();
    expect(queued).not.toHaveBeenCalled();
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1]!.message).toBe(dialogs[0]!.message);
    dialogs[1]!.onConfirm();
    await expect(sent).resolves.toBeUndefined();
    expect(queued).toHaveBeenCalledExactlyOnceWith("Option B");
  });

  it("sends nothing when the reader cancels, and says why when queueing fails", async () => {
    const cancelled = setup();
    const sent = cancelled.deliver("Option B");
    cancelled.dialogs[0]!.onCancel();
    await expect(sent).rejects.toThrow("You cancelled the message.");
    cancelled.dialogs[0]!.onConfirm();
    expect(cancelled.queued).not.toHaveBeenCalled();

    const failing = setup(() => {
      throw new Error("storage full");
    });
    const failed = failing.deliver("Option B");
    failing.dialogs[0]!.onConfirm();
    await expect(failed).rejects.toThrow("The message was not sent.");
  });
});

describe("buildHtmlRenderOutboxMessage", () => {
  it("queues the text alone, so the outbox sends it with the thread's own settings", () => {
    const message = buildHtmlRenderOutboxMessage({
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      commandId: CommandId.make("command-1"),
      text: "Option B",
      createdAt: "2026-10-31T00:00:00.000Z",
    });
    expect(message).toEqual({
      environmentId: "environment-local",
      threadId: "thread-1",
      messageId: "message-1",
      commandId: "command-1",
      text: "Option B",
      attachments: [],
      createdAt: "2026-10-31T00:00:00.000Z",
    });
    expect(message.modelSelection).toBeUndefined();
    expect(message.runtimeMode).toBeUndefined();
  });
});
