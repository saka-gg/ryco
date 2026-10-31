// How a page's `ryco.send` reaches a thread on mobile, once its WebView let the
// request through (`createHtmlRenderMessageGate`, fed a tap): a native
// confirmation with the exact text, then the thread's durable outbox, which
// sends it as it sends a message typed while the thread was busy or offline
// (the thread's own model and modes, its holds, the node's queue when the node
// keeps one). Pure, so node tests can check it; the screens wire in the dialog
// and the outbox.

import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS,
  HTML_RENDER_MESSAGE_REFUSALS,
} from "@ryco/client-runtime/state/session";

import type { QueuedThreadMessage } from "../../state/threadOutboxModel";

/** The confirmation, shaped as `showConfirmDialog` takes it. */
export interface HtmlRenderMessageConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly cancelText: string;
  readonly confirmText: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** The native confirmation for a page's message: its title, then exactly what is sent. */
export function htmlRenderMessageConfirmation(input: {
  readonly pageTitle: string;
  readonly text: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): HtmlRenderMessageConfirmRequest {
  return {
    title: "Send this message?",
    message: `The page “${input.pageTitle}” wants to send this to the thread as your message. The agent made the page, so check the text first.\n\n${input.text}`,
    cancelText: "Cancel",
    confirmText: "Send",
    onConfirm: input.onConfirm,
    onCancel: input.onCancel,
  };
}

/**
 * A page's `onSendMessage`: asks the reader, then queues the text. Resolves
 * once it is queued; rejects when the reader cancels or queueing fails. Only
 * the first answer of a dialog counts. A native dialog's Send cannot start
 * disabled, so a Send within `HTML_RENDER_MESSAGE_CONFIRM_DELAY_MS` of the
 * dialog appearing (a page's double tap landing where Send appears) asks again
 * instead of sending.
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
