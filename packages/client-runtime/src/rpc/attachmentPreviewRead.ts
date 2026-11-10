import type {
  ChatAttachmentPreviewSize,
  ChatAttachmentReadChunkInput,
  ChatAttachmentReadChunkResult,
} from "@ryco/contracts/orchestration";
import {
  assertAttachmentSize,
  assertNotAborted,
  decodeAttachmentChunk,
  readOverPinnedTransport,
  readRemainingChunks,
  type AttachmentReadTransport,
} from "./attachmentRead.ts";

// Image previews read over a connection. A subpath of its own, apart from the
// `rpc` barrel, so a client loads it only where it shows previews this way.

export interface AttachmentPreviewBytes {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** False when the server sent the original: the image is small, or it makes no previews. */
  readonly preview: boolean;
}

/**
 * Reads an image attachment's preview of `size`, or the original where there
 * is none. Null when what the server would send is larger than `maxBytes`
 * (known after the first chunk): too large to load without being asked.
 */
export async function readAttachmentPreviewBytes(input: {
  reference: Omit<ChatAttachmentReadChunkInput, "offset" | "preview">;
  size: ChatAttachmentPreviewSize;
  /** The original's size. */
  sizeBytes: number;
  maxBytes?: number;
  readChunk: (input: ChatAttachmentReadChunkInput) => Promise<ChatAttachmentReadChunkResult>;
  signal?: AbortSignal;
  /** The server answered as one that makes no previews (an older one). */
  onServerWithoutPreviews?: () => void;
}): Promise<AttachmentPreviewBytes | null> {
  assertAttachmentSize(input.sizeBytes);
  assertNotAborted(input.signal);
  const result = await input.readChunk({ ...input.reference, offset: 0, preview: input.size });
  assertNotAborted(input.signal);
  // An older server ignores `preview` and answers without it: the original.
  if (result.preview === undefined) input.onServerWithoutPreviews?.();
  const preview = result.preview === true;
  const totalBytes = preview ? result.totalBytes : input.sizeBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
    throw new Error("Invalid attachment size.");
  if (input.maxBytes !== undefined && totalBytes > input.maxBytes) return null;
  const bytes = await readRemainingChunks({
    first: decodeAttachmentChunk(result, 0, totalBytes),
    totalBytes,
    // The rest comes from the same file the first chunk did: a preview made
    // meanwhile must not mix into an original.
    readAt: (offset) =>
      input.readChunk({ ...input.reference, offset, ...(preview ? { preview: input.size } : {}) }),
    signal: input.signal,
  });
  return { bytes, preview };
}

/** Connections (their chunk readers) whose server answered a preview read with the original. */
const transportsWithoutPreviews = new WeakSet<object>();

/**
 * Reads an image attachment's preview over the transport current when the
 * read starts (see `readAttachmentBytesFromTransport`).
 */
export async function readAttachmentPreviewFromTransport(input: {
  reference: Omit<ChatAttachmentReadChunkInput, "offset" | "preview">;
  size: ChatAttachmentPreviewSize;
  sizeBytes: number;
  maxBytes?: number;
  currentTransport: () => AttachmentReadTransport | undefined;
  signal?: AbortSignal;
}): Promise<AttachmentPreviewBytes | null> {
  // A connection to a server that makes no previews would send the original:
  // learned once, so a large original is not started again just to stop.
  const transport = input.currentTransport()?.readChunk;
  if (
    transport !== undefined &&
    input.maxBytes !== undefined &&
    input.sizeBytes > input.maxBytes &&
    transportsWithoutPreviews.has(transport)
  )
    return null;
  return readOverPinnedTransport({
    current: () => input.currentTransport()?.readChunk,
    unavailable: "Attachment connection unavailable.",
    changed: "Attachment connection changed.",
    read: (readChunk) =>
      readAttachmentPreviewBytes({
        reference: input.reference,
        size: input.size,
        sizeBytes: input.sizeBytes,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(transport
          ? { onServerWithoutPreviews: () => transportsWithoutPreviews.add(transport) }
          : {}),
        readChunk,
      }),
  });
}
