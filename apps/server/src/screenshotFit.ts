/**
 * screenshotFit - Fits a PNG screenshot into a transport's base64 budget.
 *
 * MCP tool results carry images as base64 inside one JSON response, and each
 * transport caps that response. One fitter serves every caller (HTML previews,
 * device evidence) so they degrade the same way: the PNG as captured when it
 * fits, else a JPEG at full size, else a JPEG scaled down until it does.
 *
 * sharp loads on first use (`loadSharp`), so importing this module costs
 * nothing until a screenshot actually needs fitting.
 *
 * @module screenshotFit
 */
import { loadSharp } from "./loadSharp.ts";

export interface FittedScreenshot {
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}

// Full resolution matters more to an agent checking a layout than JPEG detail,
// so quality drops once before the screenshot is scaled down.
const JPEG_QUALITIES = [80, 60] as const;
const MAX_FIT_ATTEMPTS = 6;

/**
 * Fits a screenshot into `maxBase64Chars`: the PNG as captured when it fits,
 * else a JPEG at full size, else a JPEG scaled down until it does. Throws when
 * no attempt fits.
 */
export async function fitScreenshotToBase64Budget(
  pngBase64: string,
  maxBase64Chars: number,
): Promise<FittedScreenshot> {
  const sharp = await loadSharp();
  const png = Buffer.from(pngBase64, "base64");
  const { width = 0, height = 0 } = await sharp(png).metadata();
  if (pngBase64.length <= maxBase64Chars) {
    return { data: pngBase64, mimeType: "image/png", width, height };
  }
  const maxBytes = Math.floor(maxBase64Chars / 4) * 3;
  let targetWidth = width;
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS && targetWidth >= 1; attempt += 1) {
    const quality = JPEG_QUALITIES[Math.min(attempt, JPEG_QUALITIES.length - 1)];
    const pipeline = sharp(png);
    if (targetWidth < width) pipeline.resize({ width: targetWidth });
    const jpeg = await pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true });
    if (jpeg.data.byteLength <= maxBytes) {
      return {
        data: jpeg.data.toString("base64"),
        mimeType: "image/jpeg",
        width: jpeg.info.width,
        height: jpeg.info.height,
      };
    }
    if (attempt + 1 < JPEG_QUALITIES.length) continue;
    // Encoded size tracks pixel count, so scale the width by the square root, with margin.
    const scale = Math.min(0.9, Math.sqrt(maxBytes / jpeg.data.byteLength) * 0.95);
    targetWidth = Math.floor(jpeg.info.width * scale);
  }
  throw new Error("The screenshot does not fit the response.");
}
