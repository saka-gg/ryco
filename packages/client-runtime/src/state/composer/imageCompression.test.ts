import { describe, expect, it } from "vite-plus/test";

import {
  IMAGE_COMPRESSION_MAX_SOURCE_BYTES,
  compressImageWithinBytes,
  compressedImageFileName,
  createImagePreparationTracker,
  imageAttachmentSizeAction,
  imageCompressionPassSizes,
  imagePreparationSendBlock,
  type ImageCompressionCodec,
  type ImageCompressionMimeType,
  type ImageSize,
} from "./imageCompression.ts";

const MB = 1024 * 1024;

interface Encoded {
  readonly size: number;
  readonly mimeType: ImageCompressionMimeType;
  readonly quality: number;
  readonly drawnAt: ImageSize;
}

/**
 * A codec whose encoded size comes from `sizeFor`, recording each pass it draws. `drawFails`
 * makes the surface throw for the sizes it matches, as a canvas too big to allocate does.
 */
function fakeCodec(options: {
  readonly sizeFor: (drawnAt: ImageSize, quality: number) => number;
  readonly webp?: boolean;
  readonly drawFails?: (drawnAt: ImageSize) => boolean;
}) {
  const draws: Array<{ readonly size: ImageSize; readonly mimeType: ImageCompressionMimeType }> =
    [];
  const qualities: number[] = [];
  const codec: ImageCompressionCodec<Encoded> = {
    supportsWebp: async () => options.webp ?? true,
    draw: async (size, mimeType) => {
      draws.push({ size, mimeType });
      if (options.drawFails?.(size)) throw new Error("canvas allocation failed");
      return {
        encode: async (quality) => {
          qualities.push(quality);
          return { size: options.sizeFor(size, quality), mimeType, quality, drawnAt: size };
        },
      };
    },
  };
  return { codec, draws, qualities };
}

describe("imageAttachmentSizeAction", () => {
  it("keeps images within the limit and shrinks larger ones up to the decode ceiling", () => {
    expect(imageAttachmentSizeAction(10 * MB, 10 * MB)).toBe("keep");
    expect(imageAttachmentSizeAction(10 * MB + 1, 10 * MB)).toBe("compress");
    expect(imageAttachmentSizeAction(IMAGE_COMPRESSION_MAX_SOURCE_BYTES, 10 * MB)).toBe("compress");
    expect(imageAttachmentSizeAction(IMAGE_COMPRESSION_MAX_SOURCE_BYTES + 1, 10 * MB)).toBe(
      "too-large",
    );
  });
});

describe("imageCompressionPassSizes", () => {
  it("fits the long edge to 2048 px, then tries three quarters and a little over half of that", () => {
    expect(imageCompressionPassSizes({ width: 6048, height: 4032 })).toEqual([
      { width: 2048, height: 1365 },
      { width: 1536, height: 1024 },
      { width: 1126, height: 751 },
    ]);
    expect(imageCompressionPassSizes({ width: 1000, height: 3000 })).toEqual([
      { width: 683, height: 2048 },
      { width: 512, height: 1536 },
      { width: 375, height: 1126 },
    ]);
  });

  it("shrinks an image already under 2048 px from its own size", () => {
    expect(imageCompressionPassSizes({ width: 800, height: 600 })).toEqual([
      { width: 800, height: 600 },
      { width: 600, height: 450 },
      { width: 440, height: 330 },
    ]);
  });
});

describe("compressedImageFileName", () => {
  it("names the file after its new format", () => {
    expect(compressedImageFileName("shot.png", "image/webp")).toBe("shot.webp");
    expect(compressedImageFileName("Screen Shot 1.2.png", "image/jpeg")).toBe(
      "Screen Shot 1.2.jpg",
    );
    expect(compressedImageFileName("pasted", "image/webp")).toBe("pasted.webp");
    expect(compressedImageFileName("", "image/jpeg")).toBe("image.jpg");
  });
});

describe("compressImageWithinBytes", () => {
  const source = { width: 6048, height: 4032 };

  it("stops at the first quality that fits, encoding WebP at 2048 px", async () => {
    const { codec, draws, qualities } = fakeCodec({
      sizeFor: (_size, quality) => (quality <= 0.78 ? 9 * MB : 12 * MB),
    });

    const result = await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec });

    expect(result).toMatchObject({
      ok: true,
      mimeType: "image/webp",
      size: { width: 2048, height: 1365 },
      encoded: { quality: 0.78 },
    });
    expect(draws).toHaveLength(1);
    expect(qualities).toEqual([0.92, 0.85, 0.78]);
  });

  it("falls back to JPEG where WebP cannot be encoded", async () => {
    const { codec, draws } = fakeCodec({ webp: false, sizeFor: () => MB });

    const result = await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec });

    expect(result).toMatchObject({ ok: true, mimeType: "image/jpeg" });
    expect(draws.map((draw) => draw.mimeType)).toEqual(["image/jpeg"]);
  });

  it("drops resolution when even the lowest quality is too big", async () => {
    const { codec, draws, qualities } = fakeCodec({
      sizeFor: (size) => (size.width < 1500 ? 4 * MB : 20 * MB),
    });

    const result = await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec });

    expect(result).toMatchObject({ ok: true, size: { width: 1126, height: 751 } });
    expect(draws.map((draw) => draw.size.width)).toEqual([2048, 1536, 1126]);
    expect(qualities).toEqual([0.92, 0.85, 0.78, 0.68, 0.92, 0.85, 0.78, 0.68, 0.92]);
  });

  it("reports too-large when no pass fits", async () => {
    const { codec, draws } = fakeCodec({ sizeFor: () => 20 * MB });

    expect(await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec })).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(draws).toHaveLength(3);
  });

  it("moves on to a smaller pass when drawing a large one throws", async () => {
    const { codec, draws } = fakeCodec({
      sizeFor: () => MB,
      drawFails: (size) => size.width === 2048,
    });

    const result = await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec });

    expect(result).toMatchObject({ ok: true, size: { width: 1536, height: 1024 } });
    expect(draws).toHaveLength(2);
  });

  it("reports unreadable when the last pass throws and too-large when it only overflowed", async () => {
    const allFail = fakeCodec({ sizeFor: () => MB, drawFails: () => true });
    expect(
      await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec: allFail.codec }),
    ).toEqual({ ok: false, reason: "unreadable" });

    const firstFails = fakeCodec({
      sizeFor: () => 20 * MB,
      drawFails: (size) => size.width === 2048,
    });
    expect(
      await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec: firstFails.codec }),
    ).toEqual({ ok: false, reason: "too-large" });
  });

  it("tries the next pass when the encoder cannot produce the format", async () => {
    let calls = 0;
    const codec: ImageCompressionCodec<{ size: number }> = {
      supportsWebp: async () => true,
      draw: async () => ({
        encode: async () => (calls++ === 0 ? null : { size: MB }),
      }),
    };

    expect(await compressImageWithinBytes({ source, maxBytes: 10 * MB, codec })).toMatchObject({
      ok: true,
      size: { width: 1536, height: 1024 },
    });
  });
});

describe("createImagePreparationTracker", () => {
  it("holds back the send of the composer the image goes to until it is done", () => {
    const tracker = createImagePreparationTracker();
    const changes: number[] = [];
    const unsubscribe = tracker.subscribe(() => changes.push(tracker.snapshot().length));

    const finishShot = tracker.begin({ targetKey: "a", name: "shot.png", reservedBytes: 10 * MB });
    const finishPhoto = tracker.begin({ targetKey: "b", name: "photo.png", reservedBytes: MB });

    expect(tracker.pendingFor("a").map((entry) => entry.name)).toEqual(["shot.png"]);
    expect(imagePreparationSendBlock(tracker.snapshot(), "a")).toBe("Shrinking 'shot.png'…");
    expect(imagePreparationSendBlock(tracker.snapshot(), "c")).toBeNull();

    finishShot();
    finishShot();
    expect(imagePreparationSendBlock(tracker.snapshot(), "a")).toBeNull();
    expect(tracker.pendingFor("b")).toHaveLength(1);
    finishPhoto();
    unsubscribe();
    tracker.begin({ targetKey: "a", name: "late.png", reservedBytes: 1 });

    expect(changes).toEqual([1, 2, 1, 0]);
  });
});
