import type { BigIntStats } from "node:fs";

import { NotRegularFileError, openRegularFile } from "@ryco/shared/regularFile";

/**
 * Shared by the whole-file previews in `WorkspaceFileSystem` and the chunked
 * read in `previewFileChunk.ts` (loaded on first use), so both keep one set of
 * file rules and refusal strings that clients map.
 */
export const FILE_CHANGED_WHILE_READING = "File changed while it was being read. Try again.";

export function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Opens a preview's real path (containment already approved) as a regular file:
 * a final link is followed, a FIFO is never waited on, and anything else is
 * refused with the preview wording.
 */
export async function openPreviewFile(filePath: string) {
  return openRegularFile(filePath, { bigint: true, followSymlinks: true }).catch(
    (cause: unknown) => {
      throw cause instanceof NotRegularFileError
        ? new Error("Only regular files can be previewed.", { cause })
        : cause;
    },
  );
}

export function tooLargeToPreview(size: bigint, maxBytes: number): Error {
  return new Error(`File is too large to preview (${size} bytes). Limit is ${maxBytes} bytes.`);
}
