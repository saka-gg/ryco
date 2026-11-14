import { describe, expect, it } from "vite-plus/test";

import {
  detectAllowedRasterImageMimeType,
  detectRasterImageMimeType,
  inferImageExtension,
  parseBase64DataUrl,
} from "./imageMime.ts";

describe("imageMime", () => {
  it("parses base64 data URL with mime type", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses base64 data URL with mime parameters", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects non-base64 data URL", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8,hello")).toBeNull();
  });

  it("rejects missing mime type", () => {
    expect(parseBase64DataUrl("data:;base64,SGVsbG8=")).toBeNull();
  });

  it("parses base64 data URL with spaces in payload", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs bG8=\n")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });
});

describe("detectRasterImageMimeType", () => {
  const bytes = (...parts: Array<string | ReadonlyArray<number>>) =>
    Uint8Array.from(
      parts.flatMap((part) =>
        typeof part === "string" ? [...Buffer.from(part, "latin1")] : [...part],
      ),
    );
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "\0\0\0\rIHDR");
  const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0], "\0\0\0\0\0\0\0\0");
  const webp = bytes("RIFF\0\0\0\0WEBPVP8 ");

  it("types bytes by their signature", () => {
    expect(detectRasterImageMimeType(png)).toBe("image/png");
    expect(detectRasterImageMimeType(jpeg)).toBe("image/jpeg");
    expect(detectRasterImageMimeType(webp)).toBe("image/webp");
    expect(detectRasterImageMimeType(bytes("GIF87a\0\0"))).toBe("image/gif");
    expect(detectRasterImageMimeType(bytes("GIF89a\0\0"))).toBe("image/gif");
    expect(detectRasterImageMimeType(bytes("\0\0\0\x18ftypavif\0\0\0\0"))).toBe("image/avif");
    expect(detectRasterImageMimeType(bytes("\0\0\0\x18ftypmp42\0\0\0\0"))).toBeNull();
    expect(detectRasterImageMimeType(bytes("hello world"))).toBeNull();
  });

  it("refuses a GIF header with a version GIF does not have", () => {
    expect(detectRasterImageMimeType(bytes("GIF8\0\0\0\0"))).toBeNull();
    expect(detectRasterImageMimeType(bytes("GIF88a\0\0"))).toBeNull();
  });

  it("refuses a truncated signature", () => {
    expect(detectRasterImageMimeType(png.subarray(0, 7))).toBeNull();
    expect(detectRasterImageMimeType(bytes("RIFF\0\0\0\0WEB"))).toBeNull();
  });

  it("limits the answer to a call site's allowed types", () => {
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    expect(detectAllowedRasterImageMimeType(png, allowed)).toBe("image/png");
    expect(detectAllowedRasterImageMimeType(webp, allowed)).toBe("image/webp");
    expect(detectAllowedRasterImageMimeType(bytes("GIF89a\0\0"), allowed)).toBeNull();
    expect(detectAllowedRasterImageMimeType(bytes("BM\0\0\0\0"), allowed)).toBeNull();
    expect(detectAllowedRasterImageMimeType(bytes("hello"), allowed)).toBeNull();
  });
});
