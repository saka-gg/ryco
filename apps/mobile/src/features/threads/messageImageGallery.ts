import { isChatImageAttachment, type ChatMessage } from "@ryco/client-runtime/state/threads";

import { readAttachmentDimensions } from "./threadAttachmentModel";

export interface GalleryImage {
  readonly id: string;
  readonly name: string;
  readonly uri: string;
  /** Width over height, when the attachment says. */
  readonly aspectRatio: number | null;
}

/** A message's images the gallery pages through, in the order the message shows them. */
export function messageImageGallery(
  attachments: ChatMessage["attachments"],
): ReadonlyArray<GalleryImage> {
  const images: GalleryImage[] = [];
  for (const attachment of attachments ?? []) {
    if (!isChatImageAttachment(attachment) || !attachment.previewUrl) continue;
    const dimensions = readAttachmentDimensions(attachment);
    images.push({
      id: attachment.id,
      name: attachment.name,
      uri: attachment.previewUrl,
      aspectRatio: dimensions ? dimensions.width / dimensions.height : null,
    });
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
