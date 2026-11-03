import type { ChatAttachmentHandoff } from "@ryco/contracts";
import {
  htmlRenderError,
  htmlRenderResult,
  normalizeHtmlRenderTitle,
  type HtmlRenderMessageRequest,
} from "@ryco/shared/htmlRender";

import type { ChatMessage } from "../threads/types.ts";

/**
 * How every client answers a page's `ryco.send` (`ui/message`). An agent wrote
 * the page, so what it asks to send is a prompt-injection surface: the client
 * never sends on the page's word. A request passes only from the page the
 * reader is using, right after their own click, key press or tap, at most once
 * a second, one at a time, and not for a growing while after the reader
 * cancelled one; then the client shows the reader the exact text and sends it
 * only when they confirm, through the thread's own queue like a message they
 * typed. Each client brings its own gesture check and confirmation; this
 * module holds the order of the checks, the replies (fixed strings only) and
 * what both confirmations show.
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

/**
 * After the reader cancels a page's message, the page may not ask again for
 * this long, doubling with each further cancel up to
 * `HTML_RENDER_MESSAGE_MAX_CANCEL_COOLDOWN_MS`; a sent message resets it. It
 * outlasts the user activation the reader's click on Cancel gave the app (five
 * seconds in browsers), so a page that asks again at once, or keeps asking,
 * gets nothing from that click.
 */
export const HTML_RENDER_MESSAGE_CANCEL_COOLDOWN_MS = 5_000;
export const HTML_RENDER_MESSAGE_MAX_CANCEL_COOLDOWN_MS = 60_000;

/**
 * Everything a page's `ryco.send` can reject with, shown by the page. Only
 * these fixed strings reach a page: what the app knows about its connection,
 * node or queue stays in the app.
 */
export const HTML_RENDER_MESSAGE_REFUSALS = {
  unavailable: "Sending messages is not available here.",
  gesture: "Messages send only from a click, key press or tap in the page.",
  pending: "Another message is waiting for the reader to confirm it.",
  rate: "Send at most one message per second.",
  cooldown: "You cancelled the last message. Try again in a moment.",
  cancelled: "You cancelled the message.",
  threadNotOpen: "Open this page's thread to send its message.",
  threadClosed: "The thread closed before you confirmed the message.",
  notReady: "This thread cannot take messages now.",
  failed: "The message was not sent.",
} as const;

const FIXED_REFUSALS: ReadonlySet<string> = new Set(Object.values(HTML_RENDER_MESSAGE_REFUSALS));

/** The fixed reason a page hears for a failed delivery: its own message when fixed, else `failed`. */
function pageReason(error: unknown): string {
  return error instanceof Error && FIXED_REFUSALS.has(error.message)
    ? error.message
    : HTML_RENDER_MESSAGE_REFUSALS.failed;
}

/**
 * Whether a page on this message may send messages to the thread showing it:
 * only a page the thread's own agent published. A page handed over from
 * another thread (on a user message, or marked as handed over wherever it
 * arrives) never sends.
 */
export function canHtmlRenderSendFromMessage(
  message: Pick<ChatMessage, "role">,
  attachment: { readonly handoff?: ChatAttachmentHandoff | undefined },
): boolean {
  return message.role === "assistant" && attachment.handoff === undefined;
}

/** The longest page title a confirmation shows, in characters; longer ones end in an ellipsis. */
export const HTML_RENDER_MESSAGE_TITLE_MAX_CHARS = 60;

/**
 * A page's title as its confirmation names it: one line without hidden
 * characters (`normalizeHtmlRenderTitle`), and short, so it cannot crowd out
 * or pass for the message under it.
 */
export function htmlRenderMessageConfirmationTitle(title: string): string {
  const characters = Array.from(normalizeHtmlRenderTitle(title));
  if (characters.length <= HTML_RENDER_MESSAGE_TITLE_MAX_CHARS) return characters.join("");
  return `${characters
    .slice(0, HTML_RENDER_MESSAGE_TITLE_MAX_CHARS - 1)
    .join("")
    .trimEnd()}\u2026`;
}

/**
 * The size of a page's message as its confirmation states it under the text
 * ("3 lines, 42 characters"), so a reader knows how much there is to read.
 */
export function describeHtmlRenderMessageText(text: string): string {
  const lines = text.split("\n").length;
  const characters = Array.from(text).length;
  return `${lines} ${lines === 1 ? "line" : "lines"}, ${characters.toLocaleString("en-US")} ${
    characters === 1 ? "character" : "characters"
  }`;
}

/**
 * Whether a scrolling box shows the end of its content (within rounding). A
 * confirmation keeps Send disabled until its text box has, so the reader has
 * seen all of the text before it can go out.
 */
export function isHtmlRenderMessageScrolledToEnd(box: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
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
  let cancels = 0;
  let cooldownUntil = Number.NEGATIVE_INFINITY;
  return (request) => {
    const refuse = (reason: string) => options.reply(htmlRenderError(request.id, reason));
    if (!options.available()) return refuse(HTML_RENDER_MESSAGE_REFUSALS.unavailable);
    if (!options.takeGesture()) return refuse(HTML_RENDER_MESSAGE_REFUSALS.gesture);
    if ("refusal" in request) return refuse(request.refusal);
    if (pending) return refuse(HTML_RENDER_MESSAGE_REFUSALS.pending);
    const at = now();
    if (at < cooldownUntil) return refuse(HTML_RENDER_MESSAGE_REFUSALS.cooldown);
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
        cancels = 0;
        options.reply(htmlRenderResult(request.id));
      },
      (error: unknown) => {
        pending = false;
        const reason = pageReason(error);
        if (reason === HTML_RENDER_MESSAGE_REFUSALS.cancelled) {
          cancels += 1;
          cooldownUntil =
            now() +
            Math.min(
              HTML_RENDER_MESSAGE_CANCEL_COOLDOWN_MS * 2 ** (cancels - 1),
              HTML_RENDER_MESSAGE_MAX_CANCEL_COOLDOWN_MS,
            );
        }
        refuse(reason);
      },
    );
  };
}
