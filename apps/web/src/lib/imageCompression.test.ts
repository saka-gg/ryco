import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { compressImageFileToByteLimit, prepareComposerImage } from "./imageCompression";

/**
 * The unit runner has no canvas or codecs, so the browser half runs against a stubbed
 * `createImageBitmap` and `OffscreenCanvas` whose encoded size follows `sizeForQuality`, the way
 * a real encoder's output shrinks as quality drops. `supportsWebp: false` answers a WebP request
 * with a PNG, which is how a browser says it cannot encode WebP.
 */
function stubCanvas(
  sizeForQuality: (quality: number) => number,
  options?: { readonly supportsWebp?: boolean },
) {
  const close = vi.fn();
  const fillRect = vi.fn();
  const createBitmap = vi.fn(async () => ({ width: 4000, height: 3000, close }));
  vi.stubGlobal("createImageBitmap", createBitmap);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect, drawImage: vi.fn(), imageSmoothingQuality: "low" };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        const resolvedType =
          type === "image/webp" && options?.supportsWebp === false ? "image/png" : type;
        return new Blob([new Uint8Array(sizeForQuality(quality))], { type: resolvedType });
      }
    },
  );
  return { close, fillRect, createBitmap };
}

function makeImage(sizeBytes: number, name = "shot.png"): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: "image/png", lastModified: 123 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compressImageFileToByteLimit", () => {
  it("passes an image within the limit through untouched, without decoding it", async () => {
    const { createBitmap } = stubCanvas(() => 1);
    const original = makeImage(1024);

    const result = await compressImageFileToByteLimit(original, 2048);

    expect(result).toEqual({ ok: true, file: original, recompressed: false });
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it("re-encodes an oversized image as WebP under the limit, keeping transparency", async () => {
    const { close, fillRect } = stubCanvas(() => 200_000);

    const result = await compressImageFileToByteLimit(makeImage(2_000_000), 1_000_000);

    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe("image/webp");
    expect(result.ok && result.file.name).toBe("shot.webp");
    expect(result.ok && result.file.size).toBe(200_000);
    expect(result.ok && result.file.lastModified).toBe(123);
    // WebP keeps alpha, so nothing is painted under the image.
    expect(fillRect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("falls back to JPEG on a white matte where the browser cannot encode WebP", async () => {
    const { fillRect } = stubCanvas(() => 200_000, { supportsWebp: false });

    const result = await compressImageFileToByteLimit(makeImage(2_000_000), 1_000_000);

    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.file.name).toBe("shot.jpg");
    expect(fillRect).toHaveBeenCalled();
  });

  it("steps quality down until the image fits", async () => {
    stubCanvas((quality) => (quality <= 0.68 ? 900_000 : 3_000_000));

    const result = await compressImageFileToByteLimit(makeImage(5_000_000), 1_000_000);

    expect(result.ok && result.file.size).toBe(900_000);
  });

  it("reports too-large when no encoding fits, and releases the decoded image", async () => {
    const { close } = stubCanvas(() => 3_000_000);

    expect(await compressImageFileToByteLimit(makeImage(2_000_000), 1_000_000)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses a source above the decode ceiling without decoding it", async () => {
    const { createBitmap } = stubCanvas(() => 1);
    const huge = makeImage(1);
    Object.defineProperty(huge, "size", { value: 50 * 1024 * 1024 + 1 });

    expect(await compressImageFileToByteLimit(huge, 10 * 1024 * 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(createBitmap).not.toHaveBeenCalled();
  });

  it("reports unreadable when the image does not decode", async () => {
    stubCanvas(() => 1);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("corrupt image");
      }),
    );

    expect(await compressImageFileToByteLimit(makeImage(2_000_000), 1_000_000)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});

describe("compressImageFileToByteLimit with HEIC photos", () => {
  const photo = (sizeBytes: number, name = "IMG_0001.HEIC", type = "image/heic") =>
    new File([new Uint8Array(sizeBytes)], name, { type, lastModified: 123 });
  /** Chromium's answer to a HEIC photo. */
  const undecodable = () => {
    const decode = vi.fn(async () => {
      throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    });
    vi.stubGlobal("createImageBitmap", decode);
    return decode;
  };

  it("converts a photo within the limit where the browser decodes HEIC (Safari)", async () => {
    stubCanvas(() => 200_000, { supportsWebp: false });

    const result = await compressImageFileToByteLimit(photo(1_000_000), 10_000_000);

    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.file.name).toBe("IMG_0001.jpg");
  });

  it("hands a photo this browser cannot decode to the node as HEIC, typed even when the drop was not", async () => {
    stubCanvas(() => 1);
    const decode = undecodable();
    const typed = photo(1_000_000);
    expect(await compressImageFileToByteLimit(typed, 10_000_000)).toEqual({
      ok: true,
      file: typed,
      recompressed: false,
    });
    expect(decode).toHaveBeenCalledWith(typed);

    const dropped = await compressImageFileToByteLimit(
      photo(1_000_000, "scan.heif", ""),
      10_000_000,
    );
    expect(dropped.ok && dropped.file.type).toBe("image/heif");
    expect(dropped.ok && dropped.file.name).toBe("scan.heif");
    expect(dropped.ok && dropped.file.size).toBe(1_000_000);
  });

  it("refuses a photo it cannot decode that is over what the node takes", async () => {
    stubCanvas(() => 1);
    undecodable();

    expect(await compressImageFileToByteLimit(photo(12_000_000), 10_000_000)).toEqual({
      ok: false,
      reason: "heic-too-large",
    });
    expect(
      await prepareComposerImage(photo(12 * 1024 * 1024), "IMG_0001.HEIC", 10 * 1024 * 1024),
    ).toEqual({
      ok: false,
      message:
        "'IMG_0001.HEIC' is a HEIC photo over the 10MB image limit, which this browser cannot shrink. Convert it to JPEG first.",
    });
  });
});
