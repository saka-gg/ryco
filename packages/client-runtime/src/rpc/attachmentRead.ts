import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ChatAttachmentReadChunkInput,
  type ChatAttachmentReadChunkResult,
} from "@ryco/contracts";

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
      result.dataBase64.length > 4 * Math.ceil(CHAT_ATTACHMENT_READ_CHUNK_BYTES / 3)
    )
      throw new Error("Attachment changed during loading.");
    const chunk = atob(result.dataBase64);
    if (
      chunk.length === 0 ||
      chunk.length > CHAT_ATTACHMENT_READ_CHUNK_BYTES ||
      offset + chunk.length > bytes.length
    )
      throw new Error("Invalid attachment chunk.");
    for (let index = 0; index < chunk.length; index++)
      bytes[offset + index] = chunk.charCodeAt(index);
    offset += chunk.length;
  }
  return bytes;
}
