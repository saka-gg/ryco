import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatAttachmentReadChunkInput,
  type ChatAttachmentReadChunkResult,
} from "@ryco/contracts/orchestration";

/** The longest base64 text that can encode `maxChunkBytes` bytes. */
export function maxBase64ChunkLength(maxChunkBytes: number): number {
  return 4 * Math.ceil(maxChunkBytes / 3);
}

/**
 * One base64 chunk as bytes, or null for an empty chunk or one longer than
 * `maxChunkBytes` (either as text or once decoded), so each reader can refuse
 * it in its own words.
 */
export function decodeByteChunk(
  dataBase64: string,
  maxChunkBytes: number,
): Uint8Array<ArrayBuffer> | null {
  if (dataBase64.length > maxBase64ChunkLength(maxChunkBytes)) return null;
  const chunk = atob(dataBase64);
  if (chunk.length === 0 || chunk.length > maxChunkBytes) return null;
  const bytes = new Uint8Array(chunk.length);
  for (let index = 0; index < chunk.length; index++) bytes[index] = chunk.charCodeAt(index);
  return bytes;
}

/**
 * Runs `read` against the transport function current now. Every call through
 * the pinned `call`, and the end of the read, fail with `changed` when
 * `current()` no longer returns the same function, so a replacement
 * connection never contributes to an earlier attempt.
 */
export async function readOverPinnedTransport<Request, Response, Result>(input: {
  /** The environment's authorized transport function right now; undefined while disconnected. */
  readonly current: () => ((request: Request) => Promise<Response>) | undefined;
  readonly unavailable: string;
  readonly changed: string;
  readonly read: (call: (request: Request) => Promise<Response>) => Promise<Result>;
}): Promise<Result> {
  const pinned = input.current();
  if (!pinned) throw new Error(input.unavailable);
  const assertCurrent = () => {
    if (input.current() !== pinned) throw new Error(input.changed);
  };
  const result = await input.read((request) => {
    assertCurrent();
    return pinned(request);
  });
  assertCurrent();
  return result;
}

/** Chunk reads in flight at once: a slow link waits one round trip per few chunks, not per chunk. */
export const ATTACHMENT_READ_CONCURRENCY = 4;

export function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Attachment load cancelled.");
}

/** One validated chunk of a read whose total size is known. */
export function decodeAttachmentChunk(
  result: ChatAttachmentReadChunkResult,
  offset: number,
  totalBytes: number,
): Uint8Array<ArrayBuffer> {
  if (
    result.offset !== offset ||
    result.totalBytes !== totalBytes ||
    result.dataBase64.length > maxBase64ChunkLength(CHAT_ATTACHMENT_READ_CHUNK_BYTES)
  )
    throw new Error("Attachment changed during loading.");
  const chunk = decodeByteChunk(result.dataBase64, CHAT_ATTACHMENT_READ_CHUNK_BYTES);
  if (chunk === null || offset + chunk.length > totalBytes)
    throw new Error("Invalid attachment chunk.");
  return chunk;
}

/**
 * Reads the rest of a file whose first chunk is `first`: every later chunk is
 * as long as the first (the server's chunk size), the last one shorter, and up
 * to `ATTACHMENT_READ_CONCURRENCY` are in flight at once. The first failure
 * stops the read.
 */
export async function readRemainingChunks(input: {
  readonly first: Uint8Array<ArrayBuffer>;
  readonly totalBytes: number;
  readonly readAt: (offset: number) => Promise<ChatAttachmentReadChunkResult>;
  readonly signal?: AbortSignal | undefined;
}): Promise<Uint8Array<ArrayBuffer>> {
  const { first, totalBytes } = input;
  if (first.length === totalBytes) return first;
  const bytes = new Uint8Array(totalBytes);
  bytes.set(first, 0);
  const step = first.length;
  let next = step;
  let failed = false;
  const worker = async () => {
    while (!failed && next < totalBytes) {
      const offset = next;
      next += step;
      try {
        assertNotAborted(input.signal);
        const result = await input.readAt(offset);
        assertNotAborted(input.signal);
        const chunk = decodeAttachmentChunk(result, offset, totalBytes);
        if (chunk.length !== Math.min(step, totalBytes - offset))
          throw new Error("Invalid attachment chunk.");
        bytes.set(chunk, offset);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Math.min(ATTACHMENT_READ_CONCURRENCY, Math.ceil((totalBytes - step) / step));
  await Promise.all(Array.from({ length: workers }, worker));
  return bytes;
}

export function assertAttachmentSize(sizeBytes: number) {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
  )
    throw new Error("Invalid attachment size.");
}

/** Bounded reads over the existing authorized transport, several in flight; no URLs or platform imports. */
export async function readAttachmentBytes(input: {
  reference: Omit<ChatAttachmentReadChunkInput, "offset">;
  sizeBytes: number;
  readChunk: (input: ChatAttachmentReadChunkInput) => Promise<ChatAttachmentReadChunkResult>;
  signal?: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  assertAttachmentSize(input.sizeBytes);
  assertNotAborted(input.signal);
  const result = await input.readChunk({ ...input.reference, offset: 0 });
  assertNotAborted(input.signal);
  return readRemainingChunks({
    first: decodeAttachmentChunk(result, 0, input.sizeBytes),
    totalBytes: input.sizeBytes,
    readAt: (offset) => input.readChunk({ ...input.reference, offset }),
    signal: input.signal,
  });
}

export interface AttachmentReadTransport {
  readonly readChunk: (
    input: ChatAttachmentReadChunkInput,
  ) => Promise<ChatAttachmentReadChunkResult>;
}

/**
 * Reads an attachment over the transport current when the read starts. A
 * replacement connection must never contribute chunks to an earlier attempt's
 * buffer, so a transport change mid-read fails the read instead.
 */
export async function readAttachmentBytesFromTransport(input: {
  reference: Omit<ChatAttachmentReadChunkInput, "offset">;
  sizeBytes: number;
  /** The environment's authorized transport right now; undefined while disconnected. */
  currentTransport: () => AttachmentReadTransport | undefined;
  signal?: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  return readOverPinnedTransport({
    current: () => input.currentTransport()?.readChunk,
    unavailable: "Attachment connection unavailable.",
    changed: "Attachment connection changed.",
    read: (readChunk) =>
      readAttachmentBytes({
        reference: input.reference,
        sizeBytes: input.sizeBytes,
        ...(input.signal ? { signal: input.signal } : {}),
        readChunk,
      }),
  });
}
