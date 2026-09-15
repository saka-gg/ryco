import type { ScopedThreadRef } from "@ryco/contracts";
import { isChatImageAttachment, type ChatImageAttachment, type ChatMessage } from "./types.ts";

export const THREAD_IMAGES_PAGE_SIZE = 24;

export interface ThreadImage {
  readonly key: string;
  readonly messageId: ChatMessage["id"];
  readonly attachment: ChatImageAttachment;
}

/** Metadata only, from the canonical loaded history. Never scans text or fetches history/bytes. */
export function collectThreadImages(
  scope: ScopedThreadRef,
  messages: readonly ChatMessage[],
): ThreadImage[] {
  const images: ThreadImage[] = [];
  const seen = new Set<string>();
  // The thread store maintains chronological message order. Reverse messages,
  // not attachments, so a generated sequence retains its authored order.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const attachment of message.attachments ?? []) {
      if (!isChatImageAttachment(attachment) || !attachment.id) continue;
      const key = JSON.stringify([scope.environmentId, scope.threadId, message.id, attachment.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ key, messageId: message.id, attachment });
    }
  }
  return images;
}

export function threadImagesPage(images: readonly ThreadImage[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(images.length / THREAD_IMAGES_PAGE_SIZE));
  const page = Math.min(
    Math.max(0, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0),
    pageCount - 1,
  );
  return {
    page,
    pageCount,
    images: images.slice(page * THREAD_IMAGES_PAGE_SIZE, (page + 1) * THREAD_IMAGES_PAGE_SIZE),
  };
}
