/**
 * Shrinking an attached image that is over the provider's image limit instead of refusing it,
 * ported from T3 Code: the long edge drops to 2048 px and the image is re-encoded down a quality
 * ladder, with smaller passes when even the lowest quality is too big. The decisions and the
 * ladder live here; each platform supplies the decoder and the encoder (a canvas on the web).
 */

/** Longest edge kept when an image is re-encoded: a retina screenshot stays legible. */
export const IMAGE_COMPRESSION_MAX_EDGE = 2048;
/**
 * Larger sources are refused without decoding them: the file size stands in for the pixel count,
 * and decoding hundreds of megapixels can run the page out of memory.
 */
export const IMAGE_COMPRESSION_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Tried in order until the encoding fits. The floor keeps UI screenshots free of visible blocks. */
export const IMAGE_COMPRESSION_QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
/** Smaller passes, relative to the first one, for when even the lowest quality is too big. */
export const IMAGE_COMPRESSION_FALLBACK_SCALES = [0.75, 0.55] as const;

export type ImageCompressionFailure = "too-large" | "unreadable";
export type ImageCompressionMimeType = "image/webp" | "image/jpeg";

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** What adding an image of this size takes: nothing, shrinking it, or refusing it. */
export function imageAttachmentSizeAction(
  sizeBytes: number,
  maxBytes: number,
): "keep" | "compress" | "too-large" {
  if (sizeBytes <= maxBytes) return "keep";
  return sizeBytes <= IMAGE_COMPRESSION_MAX_SOURCE_BYTES ? "compress" : "too-large";
}

/**
 * The sizes the ladder draws the image at, largest first. The passes scale the first target,
 * not the 2048 px ceiling, so an image already smaller than that still gets smaller.
 */
export function imageCompressionPassSizes(source: ImageSize): ImageSize[] {
  const longEdge = Math.max(1, source.width, source.height);
  const baseEdge = Math.min(IMAGE_COMPRESSION_MAX_EDGE, longEdge);
  return [1, ...IMAGE_COMPRESSION_FALLBACK_SCALES].map((scale) => {
    const factor = Math.max(1, Math.round(baseEdge * scale)) / longEdge;
    return {
      width: Math.max(1, Math.round(source.width * factor)),
      height: Math.max(1, Math.round(source.height * factor)),
    };
  });
}

/** Re-encoding changes the format, so `shot.png` saved as WebP becomes `shot.webp`. */
export function compressedImageFileName(name: string, mimeType: ImageCompressionMimeType): string {
  const extension = mimeType === "image/webp" ? ".webp" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name || "image";
  return `${base}${extension}`;
}

/** The decoded image drawn at one size, ready to encode. */
export interface ImageCompressionSurface<TEncoded extends { readonly size: number }> {
  /** The encoded bytes, or null when the platform cannot produce the requested format. */
  readonly encode: (quality: number) => Promise<TEncoded | null>;
}

/** The platform half of the compression: its encoder and its drawing surface. */
export interface ImageCompressionCodec<TEncoded extends { readonly size: number }> {
  /**
   * Whether WebP can be encoded. At matched quality it is roughly a third smaller than JPEG and
   * keeps transparency; JPEG is the fallback.
   */
  readonly supportsWebp: () => Promise<boolean>;
  /**
   * Draws the image at `size`, over a white matte for JPEG, which has no alpha. Null when no
   * surface could be made.
   */
  readonly draw: (
    size: ImageSize,
    mimeType: ImageCompressionMimeType,
  ) => Promise<ImageCompressionSurface<TEncoded> | null>;
}

export type ImageCompressionResult<TEncoded> =
  | {
      readonly ok: true;
      readonly encoded: TEncoded;
      readonly mimeType: ImageCompressionMimeType;
      readonly size: ImageSize;
    }
  | { readonly ok: false; readonly reason: ImageCompressionFailure };

/**
 * Walks the quality ladder at each pass size until an encoding fits `maxBytes`. A pass that
 * throws (a surface too big to allocate, say) moves on to the smaller one; when the last pass
 * threw, the image is reported unreadable rather than too large.
 */
export async function compressImageWithinBytes<TEncoded extends { readonly size: number }>(input: {
  readonly source: ImageSize;
  readonly maxBytes: number;
  readonly codec: ImageCompressionCodec<TEncoded>;
}): Promise<ImageCompressionResult<TEncoded>> {
  let mimeType: ImageCompressionMimeType | undefined;
  let lastPassFailed = false;
  for (const size of imageCompressionPassSizes(input.source)) {
    try {
      mimeType ??= (await input.codec.supportsWebp()) ? "image/webp" : "image/jpeg";
      const surface = await input.codec.draw(size, mimeType);
      if (surface) {
        for (const quality of IMAGE_COMPRESSION_QUALITY_STEPS) {
          const encoded = await surface.encode(quality);
          if (!encoded) break;
          if (encoded.size <= input.maxBytes) {
            return { ok: true, encoded, mimeType, size };
          }
        }
      }
      lastPassFailed = false;
    } catch {
      lastPassFailed = true;
    }
  }
  return { ok: false, reason: lastPassFailed ? "unreadable" : "too-large" };
}

/** An image added to a composer that is still being shrunk before it joins the draft. */
export interface PendingImagePreparation {
  readonly id: number;
  /** `composerTargetKey` of the draft the image goes to. */
  readonly targetKey: string;
  readonly name: string;
  /** Counted against the message's size limit until the image arrives: at most the image limit. */
  readonly reservedBytes: number;
}

/**
 * Images being shrunk, per composer. They hold their place in the message's attachment count and
 * size, so pastes made meanwhile cannot overshoot the limits, and they hold back the send: sent
 * now, the message would go without them and they would land in the next draft.
 */
export function createImagePreparationTracker() {
  let pending: ReadonlyArray<PendingImagePreparation> = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const update = (next: ReadonlyArray<PendingImagePreparation>) => {
    pending = next;
    for (const listener of listeners) listener();
  };
  return {
    /** Starts tracking an image; the returned function stops it, once. */
    begin(entry: Omit<PendingImagePreparation, "id">): () => void {
      const id = nextId++;
      update([...pending, { ...entry, id }]);
      return () => {
        if (pending.some((candidate) => candidate.id === id)) {
          update(pending.filter((candidate) => candidate.id !== id));
        }
      };
    },
    pendingFor(targetKey: string): ReadonlyArray<PendingImagePreparation> {
      return pending.filter((entry) => entry.targetKey === targetKey);
    },
    snapshot(): ReadonlyArray<PendingImagePreparation> {
      return pending;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ImagePreparationTracker = ReturnType<typeof createImagePreparationTracker>;

/** Why the composer cannot send yet, while an image added to it is still being shrunk. */
export function imagePreparationSendBlock(
  pending: ReadonlyArray<PendingImagePreparation>,
  targetKey: string,
): string | null {
  const first = pending.find((entry) => entry.targetKey === targetKey);
  return first ? `Shrinking '${first.name}'…` : null;
}
