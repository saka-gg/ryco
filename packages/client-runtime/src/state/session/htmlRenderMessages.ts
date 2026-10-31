import {
  htmlRenderError,
  htmlRenderResult,
  type HtmlRenderMessageRequest,
} from "@ryco/shared/htmlRender";

import type { ChatMessage } from "../threads/types.ts";

/**
 * How every client answers a page's `ryco.send` (`ui/message`). An agent wrote
 * the page, so what it asks to send is a prompt-injection surface: the client
 * never sends on the page's word. A request passes only from the page the
 * reader is using, right after their own click, key press or tap, at most once
 * a second and one at a time; then the client shows the reader the exact text
 * and sends it only when they confirm, through the thread's own queue like a
 * message they typed. Each client brings its own gesture check and
 * confirmation; this module holds the order of the checks and the replies.
 */

/** A page may open at most one confirmation per this many milliseconds. */
export const HTML_RENDER_MESSAGE_MIN_INTERVAL_MS = 1_000;

/**
 * How long after the confirmation appears Send starts to count. The request
 * follows the reader's click or tap in the page, so a page could ask for a
 * quick second one where Send is about to appear; that one lands on nothing,
 * as browsers' own permission prompts arrange.
 */
export const HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS = 1_000;

/** What a page's `ryco.send` rejects with, shown by the page. */
export const HTML_RENDER_MESSAGE_REFUSALS = {
  unavailable: "Sending messages is not available here.",
  gesture: "Messages send only from a click, key press or tap in the page.",
  pending: "Another message is waiting for the reader to confirm it.",
  rate: "Send at most one message per second.",
  cancelled: "You cancelled the message.",
  failed: "The message was not sent.",
} as const;

/**
 * Whether a page on this message may send messages to the thread showing it:
 * only a page the thread's own agent published. A page handed over from
 * another thread arrives on a user message and never sends.
 */
export function canHtmlRenderSendFromMessage(message: Pick<ChatMessage, "role">): boolean {
  return message.role === "assistant";
}

export interface HtmlRenderMessageGateOptions {
  /** Whether this surface lets its page send at all; read for every request. */
  readonly available: () => boolean;
  /**
   * Whether the reader just used this page. Web reads focus and user
   * activation; mobile spends the tap that preceded the request.
   */
  readonly takeGesture: () => boolean;
  /** Asks the reader, then queues the message; rejects with the reason the page sees. */
  readonly deliver: (text: string) => Promise<void>;
  /** Posts a JSON-RPC reply into the page. */
  readonly reply: (message: unknown) => void;
  readonly now?: () => number;
}

/**
 * One page's gate: give it every `ui/message` request that page posted
 * (`readHtmlRenderMessageRequest`, checked to come from this page's own
 * window). It replies to each one, with a result once the message is queued or
 * an error with the reason.
 */
export function createHtmlRenderMessageGate(
  options: HtmlRenderMessageGateOptions,
): (request: HtmlRenderMessageRequest) => void {
  const now = options.now ?? Date.now;
  let lastAcceptedAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  return (request) => {
    const refuse = (reason: string) => options.reply(htmlRenderError(request.id, reason));
    if (!options.available()) return refuse(HTML_RENDER_MESSAGE_REFUSALS.unavailable);
    if (!options.takeGesture()) return refuse(HTML_RENDER_MESSAGE_REFUSALS.gesture);
    if ("refusal" in request) return refuse(request.refusal);
    if (pending) return refuse(HTML_RENDER_MESSAGE_REFUSALS.pending);
    const at = now();
    if (at - lastAcceptedAt < HTML_RENDER_MESSAGE_MIN_INTERVAL_MS) {
      return refuse(HTML_RENDER_MESSAGE_REFUSALS.rate);
    }
    lastAcceptedAt = at;
    pending = true;
    let delivery: Promise<void>;
    try {
      delivery = options.deliver(request.text);
    } catch (error) {
      delivery = Promise.reject(error);
    }
    void delivery.then(
      () => {
        pending = false;
        options.reply(htmlRenderResult(request.id));
      },
      (error: unknown) => {
        pending = false;
        refuse(
          error instanceof Error && error.message !== ""
            ? error.message
            : HTML_RENDER_MESSAGE_REFUSALS.failed,
        );
      },
    );
  };
}
