/**
 * The web half of shrinking an oversized image attachment: decode with `createImageBitmap`, draw
 * on a canvas, encode WebP or JPEG. The ladder and its numbers live in client-runtime. Loaded with
 * `import()` when an image over the limit is added, so it never reaches the boot bundle.
 */
import {
  compressImageWithinBytes,
  compressedImageFileName,
  imageAttachmentSizeAction,
  type ImageCompressionCodec,
  type ImageCompressionFailure,
  type ImageCompressionMimeType,
} from "@ryco/client-runtime/state/composer/imageCompression";

export type CompressImageFileResult =
  | { readonly ok: true; readonly file: File; readonly recompressed: boolean }
  | { readonly ok: false; readonly reason: ImageCompressionFailure };

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

function createCanvas(
  width: number,
  height: number,
): {
  canvas: Canvas;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    return context ? { canvas, context } : null;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

/** The encoded blob, or null when the browser produced another type: it cannot encode this one. */
async function encodeCanvas(canvas: Canvas, mimeType: string, quality: number) {
  const blob =
    typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality))
      : await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality });
  return blob?.type === mimeType ? blob : null;
}

function canvasCodec(bitmap: ImageBitmap): ImageCompressionCodec<Blob> {
  let webp: Promise<boolean> | undefined;
  return {
    supportsWebp: () => {
      webp ??= (async () => {
        const probe = createCanvas(1, 1);
        return probe !== null && (await encodeCanvas(probe.canvas, "image/webp", 1)) !== null;
      })();
      return webp;
    },
    draw: async ({ width, height }, mimeType) => {
      const target = createCanvas(width, height);
      if (!target) return null;
      if (mimeType === "image/jpeg") {
        target.context.fillStyle = "#ffffff";
        target.context.fillRect(0, 0, width, height);
      }
      target.context.imageSmoothingQuality = "high";
      target.context.drawImage(bitmap, 0, 0, width, height);
      return { encode: (quality) => encodeCanvas(target.canvas, mimeType, quality) };
    },
  };
}

/**
 * Shrinks an image file until it fits `maxBytes`, as WebP (JPEG where WebP cannot be encoded).
 * A file within the limit comes back as it is, byte for byte; one above the decode ceiling is
 * refused without being decoded.
 */
export async function compressImageFileToByteLimit(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  const action = imageAttachmentSizeAction(file.size, maxBytes);
  if (action === "keep") return { ok: true, file, recompressed: false };
  if (action === "too-large" || !canRecompress()) return { ok: false, reason: "too-large" };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const result = await compressImageWithinBytes({
      source: { width: bitmap.width, height: bitmap.height },
      maxBytes,
      codec: canvasCodec(bitmap),
    });
    if (!result.ok) return result;
    const mimeType: ImageCompressionMimeType = result.mimeType;
    return {
      ok: true,
      file: new File([result.encoded], compressedImageFileName(file.name, mimeType), {
        type: mimeType,
        lastModified: file.lastModified,
      }),
      recompressed: true,
    };
  } finally {
    bitmap.close();
  }
}
