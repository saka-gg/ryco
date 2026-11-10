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

/** Chunks requested at once after the first: about a third of the round trips. */
export const WORKSPACE_FILE_CHUNKS_IN_FLIGHT = 3;
/**
 * Recently read previews kept in memory, keyed by where they came from and
 * checked against the node's fingerprint on every open: a reopen of an
 * unchanged file costs one tiny request instead of every chunk again.
 */
const CACHE_MAX_FILES = 8;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;

interface CachedWorkspaceFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
  readonly fingerprint: string;
}

/** Insertion-ordered: the first entry is the least recently used. */
const cachedFiles = new Map<string, CachedWorkspaceFile>();
let cachedBytes = 0;

function forgetCachedFile(key: string): void {
  const entry = cachedFiles.get(key);
  if (!entry) return;
  cachedFiles.delete(key);
  cachedBytes -= entry.bytes.byteLength;
}

function rememberFile(key: string, file: CachedWorkspaceFile): void {
  forgetCachedFile(key);
  if (file.bytes.byteLength > CACHE_MAX_BYTES) return;
  cachedFiles.set(key, file);
  cachedBytes += file.bytes.byteLength;
  for (const oldest of cachedFiles.keys()) {
    if (cachedFiles.size <= CACHE_MAX_FILES && cachedBytes <= CACHE_MAX_BYTES) break;
    forgetCachedFile(oldest);
  }
}

/** Drops every remembered preview (tests; an environment's teardown may too). */
export function clearWorkspaceFileReadCache(): void {
  cachedFiles.clear();
  cachedBytes = 0;
}

/**
 * Bounded reads over the existing authorized transport. The first chunk sizes
 * the buffer and pins the file's fingerprint and type; the rest are read a few
 * at a time, every one of them must match, and the node refuses one once the
 * file changed. With `cacheScope` (the environment) the result is remembered,
 * and the next read of the file sends its fingerprint first.
 */
export async function readWorkspaceFileBytes(input: {
  readonly reference: WorkspaceFileChunkReference;
  readonly readChunk: WorkspaceFileChunkTransport["readFileChunk"];
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: WorkspaceFileReadProgress) => void) | undefined;
  readonly cacheScope?: string | undefined;
}): Promise<WorkspaceFileBytes> {
  const assertActive = () => {
    if (input.signal?.aborted) throw new Error(FILE_LOAD_CANCELLED);
  };
  const reference = { cwd: input.reference.cwd, relativePath: input.reference.relativePath };
  const cacheKey =
    input.cacheScope === undefined
      ? null
      : JSON.stringify([input.cacheScope, reference.cwd, reference.relativePath]);
  const cached = cacheKey === null ? undefined : cachedFiles.get(cacheKey);

  assertActive();
  let first = await input.readChunk(
    cached
      ? { ...reference, offset: 0, knownFingerprint: cached.fingerprint }
      : { ...reference, offset: 0 },
  );
  assertActive();
  if (
    cached &&
    cacheKey !== null &&
    first.fingerprint === cached.fingerprint &&
    first.mimeType === cached.mimeType &&
    first.totalBytes === cached.bytes.byteLength
  ) {
    rememberFile(cacheKey, cached);
    input.onProgress?.({ loadedBytes: cached.bytes.byteLength, totalBytes: first.totalBytes });
    // A copy: a consumer may transfer its buffer (to a PDF worker).
    return {
      bytes: cached.bytes.slice(),
      mimeType: cached.mimeType,
      fingerprint: cached.fingerprint,
    };
  }
  if (first.unchanged === true) {
    // Unchanged against bytes no longer held here: read the file whole.
    first = await input.readChunk({ ...reference, offset: 0 });
    assertActive();
  }
  if (
    first.offset !== 0 ||
    !Number.isSafeInteger(first.totalBytes) ||
    first.totalBytes <= 0 ||
    first.totalBytes > PROJECT_READ_FILE_CHUNKED_MAX_BYTES
  )
    throw new Error("Invalid file size.");
  const bytes = new Uint8Array(first.totalBytes);
  const { fingerprint, mimeType } = first;
  let loadedBytes = 0;

  // The node's chunk size, from the first chunk: every later one is that size, or the rest.
  let stride = 0;
  const place = (result: ProjectReadFileChunkResult, offset: number) => {
    if (
      result.offset !== offset ||
      result.totalBytes !== bytes.length ||
      result.fingerprint !== fingerprint ||
      result.mimeType !== mimeType ||
      result.unchanged === true
    )
      throw new Error(FILE_CHANGED_WHILE_READING);
    const chunk = decodeByteChunk(result.dataBase64, PROJECT_READ_FILE_CHUNK_BYTES);
    const expectedLength =
      offset === 0
        ? Math.min(chunk?.length ?? 0, bytes.length)
        : Math.min(stride, bytes.length - offset);
    if (chunk === null || chunk.length === 0 || chunk.length !== expectedLength)
      throw new Error("Invalid file chunk.");
    bytes.set(chunk, offset);
    loadedBytes += chunk.length;
    input.onProgress?.({ loadedBytes, totalBytes: bytes.length });
    return chunk.length;
  };
  stride = place(first, 0);

  const offsets: number[] = [];
  for (let offset = stride; offset < bytes.length; offset += stride) offsets.push(offset);
  const lanesState = { next: 0, failed: false };
  const lane = async () => {
    while (!lanesState.failed && lanesState.next < offsets.length) {
      const offset = offsets[lanesState.next++]!;
      assertActive();
      const result = await input.readChunk({
        ...reference,
        offset,
        expectedFingerprint: fingerprint,
      });
      if (lanesState.failed) return;
      assertActive();
      place(result, offset);
    }
  };
  const lanes = Array.from(
    { length: Math.min(WORKSPACE_FILE_CHUNKS_IN_FLIGHT, offsets.length) },
    () =>
      lane().catch((error: unknown) => {
        lanesState.failed = true;
        throw error;
      }),
  );
  await Promise.all(lanes);
  if (cacheKey !== null) rememberFile(cacheKey, { bytes: bytes.slice(), mimeType, fingerprint });
  return { bytes, mimeType, fingerprint };
}

/**
 * Reads a workspace file over the transport current when the read starts, like
 * `readAttachmentBytesFromTransport`: a transport change mid-read fails the read.
 */
export async function readWorkspaceFileBytesFromTransport(input: {
  readonly reference: WorkspaceFileChunkReference;
  /** Remembers the result for this scope (the environment); see `readWorkspaceFileBytes`. */
  readonly cacheScope?: string | undefined;
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
        cacheScope: input.cacheScope,
        signal: input.signal,
        onProgress: input.onProgress,
      }),
  });
}
