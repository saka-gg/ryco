import { describe, expect, it, vi } from "vite-plus/test";

import {
  canHtmlRenderSendFromMessage,
  createHtmlRenderMessageGate,
  HTML_RENDER_MESSAGE_REFUSALS,
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
});

describe("canHtmlRenderSendFromMessage", () => {
  it("lets only the thread's own agent pages send", () => {
    expect(canHtmlRenderSendFromMessage({ role: "assistant" })).toBe(true);
    expect(canHtmlRenderSendFromMessage({ role: "user" })).toBe(false);
    expect(canHtmlRenderSendFromMessage({ role: "system" })).toBe(false);
  });
});
