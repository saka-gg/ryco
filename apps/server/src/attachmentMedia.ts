import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

import { REGULAR_FILE_READ_FLAGS } from "@ryco/shared/regularFile";
import { Effect, Option } from "effect";
import { loadSharp } from "./loadSharp.ts";

import { IMAGE_EXTENSION_BY_MIME_TYPE } from "./imageMime.ts";

export interface AttachmentMediaDimensions {
  readonly width: number;
  readonly height: number;
}

const MEDIA_PROBE_TIMEOUT_MILLIS = 5_000;
const MP4_BOX_HEADER_SIZE = 8;
const MP4_MAX_PROBE_READS = 2048;
const MP4_LARGE_SIZE_FIELD_SIZE = 8;
const MP4_TKHD_V0_WIDTH_OFFSET = 76;
const MP4_TKHD_V1_WIDTH_OFFSET = 88;
const MP4_TKHD_FIXED_POINT_SCALE = 65536;
const MP4_MAX_DIMENSION = 1_000_000;
const MP4_HANDLER_VIDEO_TYPE = "vide";

const SERVE_CACHE_MAX_ENTRIES = 512;
const SERVE_MIME_BY_EXTENSION: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(IMAGE_EXTENSION_BY_MIME_TYPE).map(([mimeType, extension]) => [
      extension,
      mimeType,
    ]),
  ),
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
};

interface MediaBoxReader {
  readonly size: number;
  readAt(offset: number, length: number): Uint8Array | null;
}

const makeBufferBoxReader = (bytes: Uint8Array): MediaBoxReader => ({
  size: bytes.byteLength,
  readAt: (offset, length) =>
    offset >= 0 && length > 0 && offset + length <= bytes.byteLength
      ? bytes.subarray(offset, offset + length)
      : null,
});

const withFileBoxReader = <T>(absPath: string, probe: (reader: MediaBoxReader) => T): T | null => {
  let descriptor: number;
  try {
    // A synchronous open of a FIFO would wait for a writer on the event loop.
    descriptor = openSync(absPath, REGULAR_FILE_READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0) {
      return null;
    }
    const size = info.size;
    return probe({
      size,
      readAt: (offset, length) => {
        if (offset < 0 || length <= 0 || offset + length > size) {
          return null;
        }
        const bytes = new Uint8Array(length);
        return readSync(descriptor, bytes, 0, length, offset) === length ? bytes : null;
      },
    });
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
};

interface Mp4Box {
  readonly type: string;
  readonly headerSize: number;
  readonly bodyStart: number;
  readonly end: number;
}

const readMp4Box = (reader: MediaBoxReader, offset: number, limit: number): Mp4Box | null => {
  const header = reader.readAt(offset, MP4_BOX_HEADER_SIZE);
  if (!header) {
    return null;
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const type = String.fromCharCode(header[4]!, header[5]!, header[6]!, header[7]!);
  let size = view.getUint32(0);
  let headerSize = MP4_BOX_HEADER_SIZE;
  if (size === 1) {
    const largeHeader = reader.readAt(offset + MP4_BOX_HEADER_SIZE, MP4_LARGE_SIZE_FIELD_SIZE);
    if (!largeHeader) {
      return null;
    }
    const largeView = new DataView(
      largeHeader.buffer,
      largeHeader.byteOffset,
      largeHeader.byteLength,
    );
    const largeSize = largeView.getBigUint64(0);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    size = Number(largeSize);
    headerSize += MP4_LARGE_SIZE_FIELD_SIZE;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) {
    return null;
  }
  return { type, headerSize, bodyStart: offset + headerSize, end: offset + size };
};

const walkBoxes = (
  reader: MediaBoxReader,
  start: number,
  end: number,
  visit: (box: Mp4Box) => void,
): void => {
  let offset = start;
  while (offset + MP4_BOX_HEADER_SIZE <= end) {
    const box = readMp4Box(reader, offset, end);
    if (!box) {
      return;
    }
    visit(box);
    offset = box.end;
  }
};

const parseTkhdDimensions = (
  reader: MediaBoxReader,
  box: Mp4Box,
): AttachmentMediaDimensions | null => {
  const body = reader.readAt(box.bodyStart, Math.min(96, box.end - box.bodyStart));
  if (!body || (body[0] !== 0 && body[0] !== 1)) {
    return null;
  }
  const widthOffset = body[0] === 1 ? MP4_TKHD_V1_WIDTH_OFFSET : MP4_TKHD_V0_WIDTH_OFFSET;
  if (body.length < widthOffset + 8) {
    return null;
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const toDimension = (fixedPoint: number) => {
    const dimension = Math.round(fixedPoint / MP4_TKHD_FIXED_POINT_SCALE);
    return dimension > 0 && dimension <= MP4_MAX_DIMENSION ? dimension : null;
  };
  const width = toDimension(view.getUint32(widthOffset));
  const height = toDimension(view.getUint32(widthOffset + 4));
  if (width === null || height === null) return null;
  // Phone videos commonly store landscape pixels with a quarter-turn matrix.
  const matrixOffset = widthOffset - 36;
  const quarterTurn =
    view.getInt32(matrixOffset) === 0 &&
    view.getInt32(matrixOffset + 16) === 0 &&
    Math.abs(view.getInt32(matrixOffset + 4)) === MP4_TKHD_FIXED_POINT_SCALE &&
    Math.abs(view.getInt32(matrixOffset + 12)) === MP4_TKHD_FIXED_POINT_SCALE;
  return quarterTurn ? { width: height, height: width } : { width, height };
};

const findHdlrHandlerType = (reader: MediaBoxReader, start: number, end: number): string | null => {
  let handlerType: string | null = null;
  walkBoxes(reader, start, end, (box) => {
    if (box.type !== "hdlr" || handlerType !== null) {
      return;
    }
    const body = box.end - box.bodyStart >= 12 ? reader.readAt(box.bodyStart, 12) : null;
    if (body && body.length >= 12) {
      handlerType = String.fromCharCode(body[8]!, body[9]!, body[10]!, body[11]!);
    }
  });
  return handlerType;
};

const findTrakDimensions = (
  reader: MediaBoxReader,
  start: number,
  end: number,
): AttachmentMediaDimensions | null => {
  let handlerType: string | null = null;
  let dimensions: AttachmentMediaDimensions | null = null;
  walkBoxes(reader, start, end, (box) => {
    if (box.type === "mdia" && handlerType === null) {
      handlerType = findHdlrHandlerType(reader, box.bodyStart, box.end);
    } else if (box.type === "tkhd" && dimensions === null) {
      dimensions = parseTkhdDimensions(reader, box);
    }
  });
  if (handlerType !== null && handlerType !== MP4_HANDLER_VIDEO_TYPE) {
    return null;
  }
  return dimensions;
};

const probeMp4DimensionsFromReader = (source: MediaBoxReader): AttachmentMediaDimensions | null => {
  let reads = 0;
  const reader: MediaBoxReader = {
    size: source.size,
    readAt: (offset, length) => {
      // The synchronous file reader must never scan arbitrarily many tiny boxes.
      if (++reads > MP4_MAX_PROBE_READS) throw new Error("MP4 probe budget exhausted");
      return source.readAt(offset, length);
    },
  };
  let dimensions: AttachmentMediaDimensions | null = null;
  let fallbackDimensions: AttachmentMediaDimensions | null = null;
  walkBoxes(reader, 0, reader.size, (topBox) => {
    if (topBox.type !== "moov" || dimensions !== null) {
      return;
    }
    walkBoxes(reader, topBox.bodyStart, topBox.end, (moovChild) => {
      if (moovChild.type !== "trak") {
        return;
      }
      const trackDimensions = findTrakDimensions(reader, moovChild.bodyStart, moovChild.end);
      if (!trackDimensions) {
        return;
      }
      if (dimensions === null && trackHasVideoHandler(reader, moovChild)) {
        dimensions = trackDimensions;
      } else if (fallbackDimensions === null) {
        fallbackDimensions = trackDimensions;
      }
    });
    if (dimensions === null) {
      dimensions = fallbackDimensions;
    }
  });
  return dimensions;
};

const trackHasVideoHandler = (reader: MediaBoxReader, trakBox: Mp4Box): boolean => {
  let hasVideo = false;
  walkBoxes(reader, trakBox.bodyStart, trakBox.end, (box) => {
    if (box.type === "mdia" && !hasVideo) {
      hasVideo = findHdlrHandlerType(reader, box.bodyStart, box.end) === MP4_HANDLER_VIDEO_TYPE;
    }
  });
  return hasVideo;
};

const toDimensionsOrNull = (metadata: {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}): AttachmentMediaDimensions | null => {
  const width = metadata.width;
  const height = metadata.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { width, height };
};

const probeImageDimensions = (
  load: () => Promise<{
    readonly width?: number | undefined;
    readonly height?: number | undefined;
  }>,
) =>
  Effect.tryPromise(load).pipe(
    Effect.timeoutOption(MEDIA_PROBE_TIMEOUT_MILLIS),
    Effect.map((timedOut) => (Option.isSome(timedOut) ? toDimensionsOrNull(timedOut.value) : null)),
    Effect.catch(() => Effect.succeed(null)),
  );

export const probeAttachmentMediaDimensionsFromBytes = (
  bytes: Uint8Array,
  mimeType: string,
): Effect.Effect<AttachmentMediaDimensions | null> => {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return probeImageDimensions(
      async () => (await (await loadSharp())(bytes).metadata()).autoOrient,
    );
  }
  if (normalizedMimeType === "video/mp4" || normalizedMimeType === "video/quicktime") {
    return Effect.try(() => probeMp4DimensionsFromReader(makeBufferBoxReader(bytes))).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
  }
  return Effect.succeed(null);
};

export const probeAttachmentMediaDimensions = (
  absPath: string,
  mimeType: string,
): Effect.Effect<AttachmentMediaDimensions | null> => {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return probeImageDimensions(
      async () => (await (await loadSharp())(absPath).metadata()).autoOrient,
    );
  }
  if (normalizedMimeType === "video/mp4" || normalizedMimeType === "video/quicktime") {
    return Effect.try(() => withFileBoxReader(absPath, probeMp4DimensionsFromReader)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
  }
  return Effect.succeed(null);
};

interface ServeProbeCacheEntry {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dimensions: AttachmentMediaDimensions | null;
}

const serveProbeCache = new Map<string, ServeProbeCacheEntry>();

/**
 * Probes media dimensions for a persisted attachment being served back to a
 * client, keyed by extension because the attachments route serves plain files
 * without registry metadata. Results are memoized per dev/ino/size/mtime since
 * persisted attachments are immutable once renamed into place.
 */
export const probeAttachmentMediaForServing = (
  absPath: string,
  extension: string,
): Effect.Effect<AttachmentMediaDimensions | null> =>
  Effect.gen(function* () {
    const mimeType = SERVE_MIME_BY_EXTENSION[extension.toLowerCase()];
    if (!mimeType) {
      return null;
    }
    const statInfo = yield* Effect.try(() => lstatSync(absPath)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!statInfo || !statInfo.isFile()) {
      return null;
    }
    const cacheKey = `${absPath}`;
    const cached = serveProbeCache.get(cacheKey);
    if (
      cached &&
      cached.dev === statInfo.dev &&
      cached.ino === statInfo.ino &&
      cached.size === statInfo.size &&
      cached.mtimeMs === statInfo.mtimeMs
    ) {
      return cached.dimensions;
    }
    const dimensions = yield* probeAttachmentMediaDimensions(absPath, mimeType);
    if (serveProbeCache.size >= SERVE_CACHE_MAX_ENTRIES) {
      serveProbeCache.clear();
    }
    serveProbeCache.set(cacheKey, {
      dev: statInfo.dev,
      ino: statInfo.ino,
      size: statInfo.size,
      mtimeMs: statInfo.mtimeMs,
      dimensions,
    });
    return dimensions;
  });
