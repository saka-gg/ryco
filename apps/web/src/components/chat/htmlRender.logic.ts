import type { MessageId } from "@ryco/contracts";
import {
  readHtmlRenderAttachment,
  type HtmlRenderAttachment,
} from "@ryco/client-runtime/state/session";

import type { ChatMessage } from "../../types";

// Shared by every client, and read once per attachment and message object;
// see `@ryco/client-runtime/state/session` htmlRenderTimeline.
export {
  isHtmlRenderOnlyMessage,
  readHtmlRenderAttachment,
  type HtmlRenderAttachment,
} from "@ryco/client-runtime/state/session";

/**
 * The render a message attachment names, when the thread as loaded still
 * has that message and the attachment is an HTML render.
 */
export function findThreadHtmlRender(
  messages: ReadonlyArray<ChatMessage>,
  target: { readonly messageId: MessageId; readonly attachmentId: string },
): HtmlRenderAttachment | undefined {
  const attachment = messages
    .find((message) => message.id === target.messageId)
    ?.attachments?.find((candidate) => candidate.id === target.attachmentId);
  return attachment === undefined ? undefined : readHtmlRenderAttachment(attachment);
}
