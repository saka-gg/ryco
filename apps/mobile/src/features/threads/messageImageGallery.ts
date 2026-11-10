import {
  isChatImageAttachment,
  type ChatImageAttachment,
  type ChatMessage,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";

import type { AttachmentFileReference } from "./attachmentFiles";
import { readAttachmentDimensions } from "./threadAttachmentModel";

export interface GalleryImage {
  readonly id: string;
  readonly name: string;
  /** Where the image is read from: its machine's own connection. */
  readonly reference: AttachmentFileReference;
  /** A local copy that needs no read (a message this device is still sending). */
  readonly uri?: string | undefined;
  /** Width over height, when the attachment says. */
  readonly aspectRatio: number | null;
}

/** The message an image belongs to. */
export interface GalleryImageContext {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** One image attachment as the gallery shows it. */
export function galleryImage(
  context: GalleryImageContext,
  attachment: ChatImageAttachment,
): GalleryImage {
  const dimensions = readAttachmentDimensions(attachment);
  return {
    id: attachment.id,
    name: attachment.name,
    reference: {
      ...context,
      attachmentId: attachment.id,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
    },
    ...(attachment.previewUrl ? { uri: attachment.previewUrl } : {}),
    aspectRatio: dimensions ? dimensions.width / dimensions.height : null,
  };
}

/** A message's images the gallery pages through, in the order the message shows them. */
export function messageImageGallery(
  context: GalleryImageContext,
  attachments: ChatMessage["attachments"],
): ReadonlyArray<GalleryImage> {
  const images: GalleryImage[] = [];
  for (const attachment of attachments ?? []) {
    if (isChatImageAttachment(attachment)) images.push(galleryImage(context, attachment));
  }
  return images;
}

/** A downward drag past this, or a fling, closes the gallery. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 900;

export function shouldDismissGallery(input: {
  readonly translationY: number;
  readonly velocityY: number;
}): boolean {
  "worklet";
  return input.translationY > DISMISS_DISTANCE || input.velocityY > DISMISS_VELOCITY;
}

/** Backdrop opacity while the image is dragged down: fades over twice the dismiss distance. */
export function galleryBackdropOpacity(translationY: number): number {
  "worklet";
  return Math.max(0.25, 1 - Math.max(translationY, 0) / (DISMISS_DISTANCE * 2));
}
