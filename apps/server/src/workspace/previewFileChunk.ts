import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as NodeFs from "node:fs/promises";

import {
  PROJECT_READ_FILE_CHUNK_BYTES,
  PROJECT_READ_FILE_CHUNKED_MAX_BYTES,
} from "@ryco/contracts";

import { detectRasterImageMimeType } from "../imageMime.ts";
import {
  FILE_CHANGED_WHILE_READING,
  openPreviewFile,
  sameFileState,
  tooLargeToPreview,
} from "./previewFile.ts";

/**
 * The chunked PDF and image preview read. `WorkspaceFileSystem.readFileChunk`
 * imports it on first use: few servers ever preview a PDF, and the server's
 * boot chunks have a size budget (`serverBundleBoundaries.test.ts`).
 */

/** pdf.js accepts a `%PDF-` header anywhere in a file's first KiB. */
const PREVIEW_HEADER_BYTES = 1024;
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const UNSUPPORTED_PREVIEW_FILE = "Not a supported preview file.";

/** PDFs and the raster types `readFileBinary` accepts; null for anything else. */
function detectChunkedPreviewMimeType(header: Buffer): string | null {
  return (
    detectRasterImageMimeType(header) ?? (header.indexOf(PDF_MAGIC) >= 0 ? "application/pdf" : null)
  );
}

/** An opaque identity of a file's state; a rewrite between chunks changes it. */
function statFingerprint(stat: BigIntStats): string {
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  return `stat:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

async function readExactly(
  handle: NodeFs.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled !== length) throw new Error(FILE_CHANGED_WHILE_READING);
  return buffer;
}

/**
 * One bounded chunk of a PDF or raster image at `offset`, with the same
 * regular-file, link and stability rules as `readStableFileBytes`. The type is
 * sniffed from the first bytes on every chunk, so only files that look like a
 * PDF or a raster image are ever returned. That bounds what this read serves;
 * it is not a security boundary (an operator reads text through `readFile`).
 */
export async function readStableFileChunk(
  filePath: string,
  offset: number,
  expectedFingerprint: string | undefined,
): Promise<{
  readonly bytes: Buffer;
  readonly totalBytes: number;
  readonly mimeType: string;
  readonly fingerprint: string;
}> {
  const { handle, stat } = await openPreviewFile(filePath);
  try {
    if (stat.size > BigInt(PROJECT_READ_FILE_CHUNKED_MAX_BYTES)) {
      throw tooLargeToPreview(stat.size, PROJECT_READ_FILE_CHUNKED_MAX_BYTES);
    }
    const totalBytes = Number(stat.size);
    if (totalBytes === 0) throw new Error(UNSUPPORTED_PREVIEW_FILE);
    const fingerprint = statFingerprint(stat);
    // Checked before the offset, so a file that shrank between chunks reads as
    // changed rather than as a bad offset.
    if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) {
      throw new Error(FILE_CHANGED_WHILE_READING);
    }
    if (offset >= totalBytes) throw new Error("Offset is outside the file.");
    const header = await readExactly(handle, 0, Math.min(PREVIEW_HEADER_BYTES, totalBytes));
    const mimeType = detectChunkedPreviewMimeType(header);
    if (mimeType === null) throw new Error(UNSUPPORTED_PREVIEW_FILE);
    const bytes = await readExactly(
      handle,
      offset,
      Math.min(PROJECT_READ_FILE_CHUNK_BYTES, totalBytes - offset),
    );
    const afterReadStat = await handle.stat({ bigint: true });
    const pathStat = await NodeFs.stat(filePath, { bigint: true });
    if (!sameFileState(stat, afterReadStat) || !sameFileState(afterReadStat, pathStat)) {
      throw new Error(FILE_CHANGED_WHILE_READING);
    }
    return { bytes, totalBytes, mimeType, fingerprint };
  } finally {
    await handle.close();
  }
}
