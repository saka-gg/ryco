import {
  PROJECT_READ_FILE_CHUNK_BYTES,
  PROJECT_READ_FILE_CHUNKED_MAX_BYTES,
  type ProjectReadFileChunkInput,
  type ProjectReadFileChunkResult,
} from "@ryco/contracts/project";

import { decodeByteChunk, readOverPinnedTransport } from "./attachmentRead.ts";

// Its own subpath export, not the `@ryco/client-runtime/rpc` barrel: the web boot
// graph imports that barrel, which would place this lazy-only reader in boot.

const FILE_CHANGED_WHILE_READING = "File changed while it was being read. Try again.";
const FILE_LOAD_CANCELLED = "File load cancelled.";

/** A workspace file's bytes, read in bounded chunks; `mimeType` is the node's sniff, not the name's. */
export interface WorkspaceFileBytes {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
  readonly fingerprint: string;
}

export interface WorkspaceFileChunkTransport {
  readonly readFileChunk: (input: ProjectReadFileChunkInput) => Promise<ProjectReadFileChunkResult>;
}

export interface WorkspaceFileReadProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export interface WorkspaceFileChunkReference {
  readonly cwd: string;
  readonly relativePath: string;
}

/**
 * Sequential bounded reads over the existing authorized transport. The first
 * chunk sizes the buffer and pins the file's fingerprint and type; every later
 * chunk must match them, and the node refuses one once the file changed.
 */
export async function readWorkspaceFileBytes(input: {
  readonly reference: WorkspaceFileChunkReference;
  readonly readChunk: WorkspaceFileChunkTransport["readFileChunk"];
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: WorkspaceFileReadProgress) => void) | undefined;
}): Promise<WorkspaceFileBytes> {
  const assertActive = () => {
    if (input.signal?.aborted) throw new Error(FILE_LOAD_CANCELLED);
  };
  const reference = { cwd: input.reference.cwd, relativePath: input.reference.relativePath };

  assertActive();
  const first = await input.readChunk({ ...reference, offset: 0 });
  assertActive();
  if (
    first.offset !== 0 ||
    !Number.isSafeInteger(first.totalBytes) ||
    first.totalBytes <= 0 ||
    first.totalBytes > PROJECT_READ_FILE_CHUNKED_MAX_BYTES
  )
    throw new Error("Invalid file size.");
  const bytes = new Uint8Array(first.totalBytes);
  const { fingerprint, mimeType } = first;

  let result = first;
  for (let offset = 0; ;) {
    if (
      result.offset !== offset ||
      result.totalBytes !== bytes.length ||
      result.fingerprint !== fingerprint ||
      result.mimeType !== mimeType
    )
      throw new Error(FILE_CHANGED_WHILE_READING);
    const chunk = decodeByteChunk(result.dataBase64, PROJECT_READ_FILE_CHUNK_BYTES);
    if (chunk === null || offset + chunk.length > bytes.length)
      throw new Error("Invalid file chunk.");
    bytes.set(chunk, offset);
    offset += chunk.length;
    input.onProgress?.({ loadedBytes: offset, totalBytes: bytes.length });
    if (offset >= bytes.length) break;

    assertActive();
    result = await input.readChunk({ ...reference, offset, expectedFingerprint: fingerprint });
    assertActive();
  }
  return { bytes, mimeType, fingerprint };
}

/**
 * Reads a workspace file over the transport current when the read starts, like
 * `readAttachmentBytesFromTransport`: a transport change mid-read fails the read.
 */
export async function readWorkspaceFileBytesFromTransport(input: {
  readonly reference: WorkspaceFileChunkReference;
  /** The environment's authorized transport right now; undefined while disconnected. */
  readonly currentTransport: () => WorkspaceFileChunkTransport | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: WorkspaceFileReadProgress) => void) | undefined;
}): Promise<WorkspaceFileBytes> {
  return readOverPinnedTransport({
    current: () => input.currentTransport()?.readFileChunk,
    unavailable: "File connection unavailable.",
    changed: "File connection changed.",
    read: (readChunk) =>
      readWorkspaceFileBytes({
        reference: input.reference,
        readChunk,
        signal: input.signal,
        onProgress: input.onProgress,
      }),
  });
}
