import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import {
  galleryBackdropOpacity,
  messageImageGallery,
  shouldDismissGallery,
} from "./messageImageGallery";

describe("message image gallery", () => {
  it("pages through the message's previewable images in order", () => {
    const attachments = [
      {
        type: "image",
        id: "a",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "u:a",
        width: 400,
        height: 200,
      },
      {
        type: "file",
        id: "f",
        name: "f.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        previewUrl: "u:f",
      },
      { type: "image", id: "b", name: "b.png", mimeType: "image/png", sizeBytes: 1 },
      {
        type: "image",
        id: "c",
        name: "c.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "u:c",
      },
    ] as unknown as ChatMessage["attachments"];
    expect(messageImageGallery(attachments)).toEqual([
      { id: "a", name: "a.png", uri: "u:a", aspectRatio: 2 },
      { id: "c", name: "c.png", uri: "u:c", aspectRatio: null },
    ]);
    expect(messageImageGallery(undefined)).toEqual([]);
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
