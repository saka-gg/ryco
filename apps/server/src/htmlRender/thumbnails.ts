/**
 * thumbnails - Turns a screenshot of a page's top into the small data URL
 * clients show on an HTML render's card.
 *
 * @module thumbnails
 */
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_THUMBNAIL_CHARS,
  HTML_RENDER_THUMBNAIL_MAX_HEIGHT,
  HTML_RENDER_THUMBNAIL_WIDTH,
} from "@ryco/shared/htmlRender";
import sharp from "sharp";

// Stored at twice the CSS size so the card stays sharp on high-density screens.
const THUMBNAIL_PIXEL_WIDTH = 2 * HTML_RENDER_THUMBNAIL_WIDTH;
const THUMBNAIL_PIXEL_MAX_HEIGHT = 2 * HTML_RENDER_THUMBNAIL_MAX_HEIGHT;

/**
 * How much of the page's top, in CSS pixels at `HTML_RENDER_COLUMN_WIDTH`, a
 * thumbnail shows: the thumbnail's own shape at its tallest. Screenshots take
 * this much even of a shorter page, with its background below, so a card
 * that fills the thumbnail's shape never crops the page's sides.
 */
export const HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT = Math.ceil(
  (HTML_RENDER_COLUMN_WIDTH * HTML_RENDER_THUMBNAIL_MAX_HEIGHT) / HTML_RENDER_THUMBNAIL_WIDTH,
);

// Busy pages need lower qualities to fit; WebP first, which is smaller at each.
const ENCODINGS = [
  { format: "webp", quality: 75 },
  { format: "webp", quality: 60 },
  { format: "webp", quality: 45 },
  { format: "webp", quality: 30 },
  { format: "jpeg", quality: 55 },
  { format: "jpeg", quality: 35 },
] as const;

/**
 * A `data:image/...;base64` thumbnail of a page screenshot (base64 PNG):
 * scaled to twice the thumbnail width, cut to twice its height from the top,
 * and encoded small enough to fit `maxChars`. Undefined when no encoding fits.
 */
export async function encodeHtmlRenderThumbnail(
  pngBase64: string,
  maxChars: number = HTML_RENDER_MAX_THUMBNAIL_CHARS,
): Promise<string | undefined> {
  const source = sharp(Buffer.from(pngBase64, "base64"));
  const { width = 0, height = 0 } = await source.metadata();
  if (width < 1 || height < 1) return undefined;
  const scaledHeight = Math.max(1, Math.round((height * THUMBNAIL_PIXEL_WIDTH) / width));
  // Decoded and scaled once; every encoding attempt starts from these pixels.
  const { data, info } = await source
    .resize({
      width: THUMBNAIL_PIXEL_WIDTH,
      height: Math.min(THUMBNAIL_PIXEL_MAX_HEIGHT, scaledHeight),
      fit: "cover",
      position: "top",
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  for (const { format, quality } of ENCODINGS) {
    const image = sharp(data, { raw });
    const encoded = await (
      format === "webp" ? image.webp({ quality }) : image.jpeg({ quality, mozjpeg: true })
    ).toBuffer();
    const url = `data:image/${format};base64,${encoded.toString("base64")}`;
    if (url.length <= maxChars) return url;
  }
  return undefined;
}
