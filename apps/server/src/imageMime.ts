import Mime from "@effect/platform-node/Mime";

export const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

export const SAFE_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

export function parseBase64DataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/i.exec(dataUrl.trim());
  if (!match) return null;

  const headerParts = (match[1] ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (headerParts.length < 2) {
    return null;
  }
  const trailingToken = headerParts.at(-1)?.toLowerCase();
  if (trailingToken !== "base64") {
    return null;
  }

  const mimeType = headerParts[0]?.toLowerCase();
  const base64 = match[2]?.replace(/\s+/g, "");
  if (!mimeType || !base64) return null;

  return { mimeType, base64 };
}

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(IMAGE_EXTENSION_BY_MIME_TYPE, key)
    ? IMAGE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
  if (fromMime) {
    return fromMime;
  }

  const fromMimeExtension = Mime.getExtension(input.mimeType);
  if (fromMimeExtension && SAFE_IMAGE_FILE_EXTENSIONS.has(fromMimeExtension)) {
    return fromMimeExtension;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_IMAGE_FILE_EXTENSIONS.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".bin";
}

const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC_BYTES = [0xff, 0xd8, 0xff];
const GIF_MAGIC_BYTES = [0x47, 0x49, 0x46, 0x38];
const BMP_MAGIC_BYTES = [0x42, 0x4d];
const ICO_MAGIC_BYTES = [0x00, 0x00, 0x01, 0x00];
const RIFF_MAGIC_BYTES = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC_BYTES = [0x57, 0x45, 0x42, 0x50];
const ISO_BASE_MEDIA_FTYP_BYTES = [0x66, 0x74, 0x79, 0x70];
const ISO_BASE_MEDIA_IMAGE_BRANDS: Readonly<Record<string, string>> = {
  avif: "image/avif",
  avis: "image/avif",
  heic: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  heix: "image/heic",
  hevc: "image/heic",
  hevm: "image/heic",
  hevs: "image/heic",
  hevx: "image/heic",
  mif1: "image/heic",
  msf1: "image/heic",
};

function hasMagicBytes(bytes: Uint8Array, magic: ReadonlyArray<number>, offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((value, index) => bytes[offset + index] === value);
}

/**
 * Raster previews are typed by what the bytes are, never by what the path
 * claims: the client renders these bytes in an image view, so a mislabelled
 * extension must not decide the mime type. Unsupported magic numbers are
 * refused rather than guessed at.
 */
export function detectRasterImageMimeType(bytes: Uint8Array): string | null {
  if (hasMagicBytes(bytes, PNG_MAGIC_BYTES)) return "image/png";
  if (hasMagicBytes(bytes, JPEG_MAGIC_BYTES)) return "image/jpeg";
  if (hasMagicBytes(bytes, GIF_MAGIC_BYTES)) return "image/gif";
  if (hasMagicBytes(bytes, RIFF_MAGIC_BYTES) && hasMagicBytes(bytes, WEBP_MAGIC_BYTES, 8)) {
    return "image/webp";
  }
  if (hasMagicBytes(bytes, BMP_MAGIC_BYTES)) return "image/bmp";
  if (hasMagicBytes(bytes, ICO_MAGIC_BYTES)) return "image/x-icon";
  if (hasMagicBytes(bytes, ISO_BASE_MEDIA_FTYP_BYTES, 4)) {
    // Video containers share the ISO base-media ftyp header, so only the
    // still-image brands are accepted; an mp4 brand falls through to refusal.
    const brand = Buffer.from(bytes.subarray(8, 12)).toString("latin1");
    return ISO_BASE_MEDIA_IMAGE_BRANDS[brand] ?? null;
  }
  return null;
}
