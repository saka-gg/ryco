import { MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canHtmlRenderSendFromMessage,
  createHtmlRenderMessageGate,
  describeHtmlRenderMessageText,
  HTML_RENDER_MESSAGE_REFUSALS,
  htmlRenderMessageConfirmationTitle,
  isHtmlRenderMessageScrolledToEnd,
  type HtmlRenderMessageGateOptions,
} from "./htmlRenderMessages.ts";

function setup(overrides: Partial<HtmlRenderMessageGateOptions> = {}) {
  let clock = 10_000;
  const replies: unknown[] = [];
  const deliver = vi.fn(async (_text: string) => undefined);
  const gate = createHtmlRenderMessageGate({
    available: () => true,
    takeGesture: () => true,
    deliver,
    reply: (message) => replies.push(message),
    now: () => clock,
    ...overrides,
  });
  return {
    gate,
    deliver,
    replies,
    advance: (ms: number) => {
      clock += ms;
    },
    settled: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const error = (id: string, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32000, message },
});
const result = (id: string) => ({ jsonrpc: "2.0", id, result: {} });

describe("createHtmlRenderMessageGate", () => {
  it("delivers the reader's answer and replies once it is queued", async () => {
    const run = setup();
    run.gate({ id: "m1", text: "Option B" });
    expect(run.deliver).toHaveBeenCalledWith("Option B");
    await run.settled();
    expect(run.replies).toEqual([result("m1")]);
  });

  it("refuses a surface that cannot send, and a page the reader did not just use", async () => {
    const unavailable = setup({ available: () => false });
    unavailable.gate({ id: "m1", text: "x" });
    expect(unavailable.replies).toEqual([error("m1", HTML_RENDER_MESSAGE_REFUSALS.unavailable)]);

    const idle = setup({ takeGesture: () => false });
    idle.gate({ id: "m1", text: "x" });
    expect(idle.replies).toEqual([error("m1", HTML_RENDER_MESSAGE_REFUSALS.gesture)]);
    expect(unavailable.deliver).not.toHaveBeenCalled();
    expect(idle.deliver).not.toHaveBeenCalled();
  });

  it("passes on why the text cannot be sent", () => {
    const run = setup();
    run.gate({ id: "m1", refusal: "A page cannot send a slash command." });
    expect(run.replies).toEqual([error("m1", "A page cannot send a slash command.")]);
    expect(run.deliver).not.toHaveBeenCalled();
  });

  it("keeps one confirmation at a time and at most one a second", async () => {
    let finish: (() => void) | undefined;
    const run = setup({
      deliver: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    run.gate({ id: "m1", text: "first" });
    run.advance(5_000);
    run.gate({ id: "m2", text: "second" });
    expect(run.replies).toEqual([error("m2", HTML_RENDER_MESSAGE_REFUSALS.pending)]);
    finish?.();
    await run.settled();
    expect(run.replies.at(-1)).toEqual(result("m1"));

    const fast = setup();
    fast.gate({ id: "m1", text: "first" });
    await fast.settled();
    fast.advance(999);
    fast.gate({ id: "m2", text: "second" });
    expect(fast.replies.at(-1)).toEqual(error("m2", HTML_RENDER_MESSAGE_REFUSALS.rate));
    fast.advance(1);
    fast.gate({ id: "m3", text: "third" });
    await fast.settled();
    expect(fast.replies.at(-1)).toEqual(result("m3"));
    expect(fast.deliver).toHaveBeenCalledTimes(2);
  });

  it("rejects with the reason the delivery gave, or a plain one", async () => {
    const cancelled = setup({
      deliver: async () => {
        throw new Error(HTML_RENDER_MESSAGE_REFUSALS.cancelled);
      },
    });
    cancelled.gate({ id: "m1", text: "x" });
    await cancelled.settled();
    expect(cancelled.replies).toEqual([error("m1", HTML_RENDER_MESSAGE_REFUSALS.cancelled)]);

    const thrown = setup({
      deliver: () => {
        throw "not an error";
      },
    });
    thrown.gate({ id: "m1", text: "x" });
    await thrown.settled();
    expect(thrown.replies).toEqual([error("m1", HTML_RENDER_MESSAGE_REFUSALS.failed)]);
    // A failed delivery frees the gate for the reader's next try.
    thrown.advance(1_000);
    thrown.gate({ id: "m2", text: "y" });
    await thrown.settled();
    expect(thrown.replies.at(-1)).toEqual(error("m2", HTML_RENDER_MESSAGE_REFUSALS.failed));
  });

  it("tells a page only fixed reasons, never what the app knows about its node or queue", async () => {
    for (const message of [
      "Commands are unavailable while Office Mac reconnects.",
      "Queue write failed: SQLITE_BUSY",
      "",
    ]) {
      const run = setup({
        deliver: async () => {
          throw new Error(message);
        },
      });
      run.gate({ id: "m1", text: "x" });
      await run.settled();
      expect(run.replies).toEqual([error("m1", HTML_RENDER_MESSAGE_REFUSALS.failed)]);
    }
    for (const reason of Object.values(HTML_RENDER_MESSAGE_REFUSALS)) {
      const run = setup({
        deliver: async () => {
          throw new Error(reason);
        },
      });
      run.gate({ id: "m1", text: "x" });
      await run.settled();
      expect(run.replies).toEqual([error("m1", reason)]);
    }
  });

  it("makes a page wait longer after each cancel, until the reader sends one", async () => {
    let answer: "send" | "cancel" = "cancel";
    const deliver = vi.fn(async (_text: string) => {
      if (answer === "cancel") throw new Error(HTML_RENDER_MESSAGE_REFUSALS.cancelled);
    });
    const run = setup({ deliver });
    const ask = async (id: string) => {
      run.gate({ id, text: "x" });
      await run.settled();
      return run.replies.at(-1);
    };
    expect(await ask("m1")).toEqual(error("m1", HTML_RENDER_MESSAGE_REFUSALS.cancelled));
    // A page asking again at once, or a little later, opens nothing.
    run.advance(1_000);
    expect(await ask("m2")).toEqual(error("m2", HTML_RENDER_MESSAGE_REFUSALS.cooldown));
    run.advance(3_999);
    expect(await ask("m3")).toEqual(error("m3", HTML_RENDER_MESSAGE_REFUSALS.cooldown));
    run.advance(1);
    expect(await ask("m4")).toEqual(error("m4", HTML_RENDER_MESSAGE_REFUSALS.cancelled));
    // The second cancel in a row doubles the wait.
    run.advance(9_999);
    expect(await ask("m5")).toEqual(error("m5", HTML_RENDER_MESSAGE_REFUSALS.cooldown));
    run.advance(1);
    answer = "send";
    expect(await ask("m6")).toEqual(result("m6"));
    expect(deliver).toHaveBeenCalledTimes(3);
    // A sent message starts the count over.
    answer = "cancel";
    run.advance(1_000);
    expect(await ask("m7")).toEqual(error("m7", HTML_RENDER_MESSAGE_REFUSALS.cancelled));
    run.advance(5_000);
    expect(await ask("m8")).toEqual(error("m8", HTML_RENDER_MESSAGE_REFUSALS.cancelled));
    // ...and the wait never grows past a minute.
    for (let index = 0; index < 6; index += 1) {
      run.advance(60_000);
      await ask(`m9-${index}`);
    }
    run.advance(59_999);
    expect(await ask("m10")).toEqual(error("m10", HTML_RENDER_MESSAGE_REFUSALS.cooldown));
    run.advance(1);
    expect(await ask("m11")).toEqual(error("m11", HTML_RENDER_MESSAGE_REFUSALS.cancelled));
  });
});

describe("canHtmlRenderSendFromMessage", () => {
  it("lets only the thread's own agent pages send, never one handed over", () => {
    const own = {};
    const handedOver = {
      handoff: { threadId: ThreadId.make("parent"), messageId: MessageId.make("parent-message") },
    };
    expect(canHtmlRenderSendFromMessage({ role: "assistant" }, own)).toBe(true);
    expect(canHtmlRenderSendFromMessage({ role: "assistant" }, handedOver)).toBe(false);
    expect(canHtmlRenderSendFromMessage({ role: "user" }, own)).toBe(false);
    expect(canHtmlRenderSendFromMessage({ role: "system" }, own)).toBe(false);
  });
});

describe("what a confirmation shows", () => {
  it("names the page in one short line, whatever its title holds", () => {
    expect(htmlRenderMessageConfirmationTitle("Pick a plan")).toBe("Pick a plan");
    // The review's title: line breaks that would fake lines of the message.
    expect(
      htmlRenderMessageConfirmationTitle(
        `Poll\u201d is Ryco's.\n\nOption B${"\n".repeat(40)}\u201c`,
      ),
    ).toBe("Poll\u201d is Ryco's. Option B \u201c");
    expect(htmlRenderMessageConfirmationTitle("a\u200b\u2800\u2800b\u0007")).toBe("a b");
    const long = htmlRenderMessageConfirmationTitle(`${"word ".repeat(30)}end`);
    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith("\u2026")).toBe(true);
    expect(long).not.toContain("end");
    // Never cut inside an emoji.
    expect(Array.from(htmlRenderMessageConfirmationTitle("\ud83d\udc4d".repeat(80)))).toEqual([
      ...Array.from("\ud83d\udc4d".repeat(59)),
      "\u2026",
    ]);
  });

  it("states the size of the text", () => {
    expect(describeHtmlRenderMessageText("B")).toBe("1 line, 1 character");
    expect(describeHtmlRenderMessageText("Option B\nwith notes")).toBe("2 lines, 19 characters");
    expect(describeHtmlRenderMessageText(`${"a".repeat(999)}\ud83d\udc4d`)).toBe(
      "1 line, 1,000 characters",
    );
  });

  it("knows when the reader has scrolled to the end of the text", () => {
    expect(
      isHtmlRenderMessageScrolledToEnd({ scrollTop: 0, clientHeight: 240, scrollHeight: 240 }),
    ).toBe(true);
    expect(
      isHtmlRenderMessageScrolledToEnd({ scrollTop: 0, clientHeight: 240, scrollHeight: 400 }),
    ).toBe(false);
    expect(
      isHtmlRenderMessageScrolledToEnd({ scrollTop: 159, clientHeight: 240, scrollHeight: 400 }),
    ).toBe(true);
    expect(
      isHtmlRenderMessageScrolledToEnd({ scrollTop: 100, clientHeight: 240, scrollHeight: 400 }),
    ).toBe(false);
  });
});
