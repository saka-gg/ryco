import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Read size for hashing: large enough to stream a 256 MiB artifact without many reads. */
const HASH_READ_BYTES = 1024 * 1024;

export interface FileSha256 {
  /** Lowercase hex sha-256 of the file's raw bytes. */
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Streams a file through sha-256 without holding it in memory, and counts its bytes on the way.
 * Aborting `signal` stops the read and rejects.
 */
export const sha256File = async (filePath: string, signal?: AbortSignal): Promise<FileSha256> => {
  const hash = createHash("sha256");
  let byteLength = 0;
  const stream = createReadStream(filePath, {
    highWaterMark: HASH_READ_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { sha256: hash.digest("hex"), byteLength };
};
