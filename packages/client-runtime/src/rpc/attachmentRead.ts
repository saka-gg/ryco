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

/** Sequential, bounded reads over the existing authorized transport; no URLs or platform imports. */
export async function readAttachmentBytes(input: {
  reference: Omit<ChatAttachmentReadChunkInput, "offset">;
  sizeBytes: number;
  readChunk: (input: ChatAttachmentReadChunkInput) => Promise<ChatAttachmentReadChunkResult>;
  signal?: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
  )
    throw new Error("Invalid attachment size.");
  const bytes = new Uint8Array(input.sizeBytes);
  for (let offset = 0; offset < bytes.length;) {
    if (input.signal?.aborted) throw new Error("Attachment load cancelled.");
    const result = await input.readChunk({ ...input.reference, offset });
    if (input.signal?.aborted) throw new Error("Attachment load cancelled.");
    if (
      result.offset !== offset ||
      result.totalBytes !== bytes.length ||
      result.dataBase64.length > maxBase64ChunkLength(CHAT_ATTACHMENT_READ_CHUNK_BYTES)
    )
      throw new Error("Attachment changed during loading.");
    const chunk = decodeByteChunk(result.dataBase64, CHAT_ATTACHMENT_READ_CHUNK_BYTES);
    if (chunk === null || offset + chunk.length > bytes.length)
      throw new Error("Invalid attachment chunk.");
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
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
