// How a page's `ryco.send` reaches a thread on mobile, once its WebView let the
// request through (`createHtmlRenderMessageGate`, fed a tap): the app's own
// confirmation with the exact text, then the thread's durable outbox, which
// sends it as it sends a message typed while the thread was busy or offline
// (the thread's own model and modes, its holds, the node's queue when the node
// keeps one). Pure, so node tests can check it; the screens wire in the dialog
// and the outbox.

import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  describeHtmlRenderMessageText,
  HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS,
  HTML_RENDER_MESSAGE_REFUSALS,
  htmlRenderMessageConfirmationTitle,
} from "@ryco/client-runtime/state/session";

import type { QueuedThreadMessage } from "../../state/threadOutboxModel";

/** The confirmation, shaped as `showConfirmDialog` takes it. */
export interface HtmlRenderMessageConfirmRequest {
  readonly title: string;
  readonly message: string;
  /** Exactly what is sent, in a box of its own, with its size under it. */
  readonly quote: { readonly text: string; readonly caption: string };
  readonly confirmDelayMs: number;
  readonly cancelText: string;
  readonly confirmText: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The confirmation for a page's message: what asks (the page's title, one
 * short line), then exactly what is sent, kept apart from anything the page
 * wrote, so no title can pass for part of the message. Send waits a moment
 * and until the reader has scrolled to the end of the text. It is the app's
 * own dialog on both platforms (`showConfirmDialog` with a quote).
 */
export function htmlRenderMessageConfirmation(input: {
  readonly pageTitle: string;
  readonly text: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): HtmlRenderMessageConfirmRequest {
  return {
    title: "Send this message?",
    message: `The page “${htmlRenderMessageConfirmationTitle(input.pageTitle)}” wants to send this to the thread as your message. The agent made the page, so check the text first.`,
    quote: { text: input.text, caption: describeHtmlRenderMessageText(input.text) },
    confirmDelayMs: HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS,
    cancelText: "Cancel",
    confirmText: "Send",
    onConfirm: input.onConfirm,
    onCancel: input.onCancel,
  };
}

/**
 * A page's `onSendMessage`: asks the reader, then queues the text. Resolves
 * once it is queued; rejects when the reader cancels or queueing fails. Only
 * the first answer of a dialog counts. The dialog keeps Send disabled for
 * `HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS`; should a Send still come sooner
 * after the dialog was asked for (a page's double tap landing where Send
 * appears), it asks again instead of sending.
 */
export function createHtmlRenderMessageDelivery(deps: {
  readonly pageTitle: string;
  readonly confirm: (request: HtmlRenderMessageConfirmRequest) => void;
  readonly queue: (text: string) => void;
  readonly now?: () => number;
}): (text: string) => Promise<void> {
  const now = deps.now ?? Date.now;
  return (text) =>
    new Promise<void>((resolve, reject) => {
      const ask = () => {
        const shownAt = now();
        let answered = false;
        deps.confirm(
          htmlRenderMessageConfirmation({
            pageTitle: deps.pageTitle,
            text,
            onConfirm: () => {
              if (answered) return;
              answered = true;
              if (now() - shownAt < HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS) {
                ask();
                return;
              }
              try {
                deps.queue(text);
                resolve();
              } catch {
                reject(new Error(HTML_RENDER_MESSAGE_REFUSALS.failed));
              }
            },
            onCancel: () => {
              if (answered) return;
              answered = true;
              reject(new Error(HTML_RENDER_MESSAGE_REFUSALS.cancelled));
            },
          }),
        );
      };
      ask();
    });
}

/**
 * A page's message as an outbox entry: the text alone. Without its own model
 * and modes, the outbox sends it with the thread's (`resolveQueuedThreadSettings`).
 */
export function buildHtmlRenderOutboxMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.messageId,
    commandId: input.commandId,
    text: input.text,
    attachments: [],
    createdAt: input.createdAt,
  };
}
