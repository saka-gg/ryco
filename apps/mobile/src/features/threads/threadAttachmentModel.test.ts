import { describe, expect, it } from "vite-plus/test";

import type { ChatAttachment } from "@ryco/client-runtime/state/threads";

import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  IMAGE_ATTACHMENT_SLOT_WIDTH,
  imageAttachmentPreviewSize,
  isVideoFileAttachment,
  readAttachmentDimensions,
} from "./threadAttachmentModel";

describe("readAttachmentDimensions", () => {
  it("returns both dimensions when they are present and positive", () => {
    expect(
      readAttachmentDimensions({
        type: "image",
        id: "att-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10,
        width: 640,
        height: 480,
      }),
    ).toEqual({ width: 640, height: 480 });
  });

  it("returns null when either dimension is missing", () => {
    expect(
      readAttachmentDimensions({
        type: "image",
        id: "att-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10,
        width: 640,
      } as ChatAttachment),
    ).toBeNull();
    expect(
      readAttachmentDimensions({
        type: "image",
        id: "att-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10,
      }),
    ).toBeNull();
  });

  it("returns null when a dimension is zero", () => {
    expect(
      readAttachmentDimensions({
        type: "file",
        id: "att-2",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 10,
        width: 1920,
        height: 0,
      }),
    ).toBeNull();
  });
});

describe("isVideoFileAttachment", () => {
  it("matches file attachments with a video mime type", () => {
    expect(
      isVideoFileAttachment({
        type: "file",
        id: "att-2",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 10,
      }),
    ).toBe(true);
    expect(
      isVideoFileAttachment({
        type: "file",
        id: "att-2",
        name: "clip.mov",
        mimeType: "VIDEO/QuickTime",
        sizeBytes: 10,
      }),
    ).toBe(true);
  });

  it("does not match non-video files, images, or unknown attachments", () => {
    expect(
      isVideoFileAttachment({
        type: "file",
        id: "att-3",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }),
    ).toBe(false);
    expect(
      isVideoFileAttachment({
        type: "image",
        id: "att-4",
        name: "shot.png",
        mimeType: "video/mp4",
        sizeBytes: 10,
      }),
    ).toBe(false);
    expect(isVideoFileAttachment({ type: "future-kind", name: "mystery" })).toBe(false);
  });
});

describe("slot constants", () => {
  it("keeps the fixed image slot at the previous w-36 width", () => {
    expect(IMAGE_ATTACHMENT_SLOT_WIDTH).toBe(144);
  });

  it("defaults unknown media dimensions to a 16:9 slot", () => {
    expect(DEFAULT_MEDIA_ASPECT_RATIO).toBeCloseTo(16 / 9);
  });
});

describe("imageAttachmentPreviewSize", () => {
  it("picks the smaller preview where it is sharp on a 3x screen", () => {
    expect(imageAttachmentPreviewSize({ width: 2880, height: 1800 })).toBe(512);
    expect(imageAttachmentPreviewSize({ width: 1170, height: 2532 })).toBe(1024);
    expect(imageAttachmentPreviewSize(null)).toBe(1024);
  });
});
