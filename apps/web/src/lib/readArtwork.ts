import { analyzeArtworkPixels, type ArtworkAnalysis } from "./artworkFit.logic";
import { LRUCache } from "./lruCache";

/** Artwork is sampled at most this many px on its longest side: plenty to find its shape. */
const SAMPLE_SIDE = 96;

// Keyed by source; a data URL key is the artwork itself, hence the byte budget.
const analyses = new LRUCache<{ readonly analysis: ArtworkAnalysis | null }>(32, 4 * 1024 * 1024);

/**
 * Analyses a loaded image's pixels for `fitArtwork`. Null when they cannot be
 * read: a cross-origin image taints the canvas, and an image without intrinsic
 * size has nothing to sample.
 */
export function readArtworkAnalysis(image: HTMLImageElement): ArtworkAnalysis | null {
  const source = image.currentSrc || image.src;
  const cached = source ? analyses.get(source) : null;
  if (cached) return cached.analysis;
  const { naturalWidth, naturalHeight } = image;
  if (naturalWidth <= 0 || naturalHeight <= 0) return null;
  const analysis = samplePixels(image, naturalWidth, naturalHeight);
  if (source) analyses.set(source, { analysis }, source.length * 2);
  return analysis;
}

function samplePixels(image: HTMLImageElement, naturalWidth: number, naturalHeight: number) {
  const scale = Math.min(1, SAMPLE_SIDE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return analyzeArtworkPixels(context.getImageData(0, 0, width, height).data, width, height);
  } catch {
    // A SecurityError from a tainted canvas, or an undecodable image.
    return null;
  }
}
