import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import {
  galleryBackdropOpacity,
  messageImageGallery,
  shouldDismissGallery,
  type GalleryImageContext,
} from "./messageImageGallery";

describe("message image gallery", () => {
  it("pages through the message's images in order, read over their machine unless local", () => {
    const context = {
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "message-1",
    } as unknown as GalleryImageContext;
    const attachments = [
      {
        type: "image",
        id: "a",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 10,
        width: 400,
        height: 200,
      },
      { type: "file", id: "f", name: "f.txt", mimeType: "text/plain", sizeBytes: 1 },
      {
        type: "image",
        id: "c",
        name: "c.png",
        mimeType: "image/png",
        sizeBytes: 3,
        previewUrl: "file:///local/c.png",
      },
    ] as unknown as ChatMessage["attachments"];
    expect(messageImageGallery(context, attachments)).toEqual([
      {
        id: "a",
        name: "a.png",
        reference: { ...context, attachmentId: "a", name: "a.png", sizeBytes: 10 },
        aspectRatio: 2,
      },
      {
        id: "c",
        name: "c.png",
        reference: { ...context, attachmentId: "c", name: "c.png", sizeBytes: 3 },
        uri: "file:///local/c.png",
        aspectRatio: null,
      },
    ]);
    expect(messageImageGallery(context, undefined)).toEqual([]);
  });

  it("closes on a long drag or a downward fling and fades the backdrop", () => {
    expect(shouldDismissGallery({ translationY: 130, velocityY: 0 })).toBe(true);
    expect(shouldDismissGallery({ translationY: 40, velocityY: 1_000 })).toBe(true);
    expect(shouldDismissGallery({ translationY: 40, velocityY: 200 })).toBe(false);
    expect(galleryBackdropOpacity(0)).toBe(1);
    expect(galleryBackdropOpacity(120)).toBe(0.5);
    expect(galleryBackdropOpacity(10_000)).toBe(0.25);
  });
});
