/**
 * Unpacks a plain-folder copy (`folder-archive`) into the import's staging directory.
 *
 * The archive came from another node, so it is read as untrusted: the `tar` package keeps every
 * entry inside the directory (no absolute paths, no `..`, nothing written through a symlink),
 * only files, folders and symlinks are written (no hard links, devices or FIFOs), owners are
 * never restored, and the unpacked bytes and entries are bounded so a small archive cannot fill
 * the disk. Entries `tar` refuses are skipped and counted; a broken archive fails the step.
 *
 * @module importFolder
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import {
  PROJECT_COPY_FOLDER_MAX_BYTES,
  PROJECT_COPY_FOLDER_MAX_FILES,
} from "@ryco/contracts/project-copy";
import { Effect } from "effect";

/** Folders count too: a folder of `PROJECT_COPY_FOLDER_MAX_FILES` files has fewer than that. */
const MAX_ENTRIES = 2 * PROJECT_COPY_FOLDER_MAX_FILES;
const WRITABLE_TYPES = new Set(["File", "OldFile", "ContiguousFile", "Directory", "SymbolicLink"]);

export class FolderArchiveError extends Error {
  readonly _tag = "FolderArchiveError";
}

export interface FolderArchiveResult {
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Entries refused: unsafe paths, links, special files. */
  readonly skippedEntries: number;
}

/**
 * Unpacks `archivePath` into `directory` (which must exist and be the job's own). `onProgress`
 * gets the share of the archive read, 0 to 100. Interrupting stops the read; the caller removes
 * the half-written directory.
 */
export const extractFolderArchive = (input: {
  readonly archivePath: string;
  readonly directory: string;
  readonly onProgress?: (percent: number) => void;
}): Effect.Effect<FolderArchiveResult, FolderArchiveError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const tar = await import("tar");
      const archiveBytes = (await stat(input.archivePath)).size;
      let read = 0;
      let lastPercent = -1;
      let entries = 0;
      let fileCount = 0;
      let totalBytes = 0;
      let skippedEntries = 0;
      let overLimit: string | null = null;
      const source = createReadStream(input.archivePath);
      source.on("data", (chunk) => {
        read += chunk.length;
        const percent = archiveBytes === 0 ? 100 : Math.floor((read / archiveBytes) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          input.onProgress?.(percent);
        }
      });
      const unpack = tar.extract({
        cwd: input.directory,
        // Owners and the process's own umask: the copy belongs to whoever runs this node.
        preserveOwner: false,
        // Unsafe entries are skipped (and counted), not fatal; a broken archive still fails.
        strict: false,
        onwarn: (code: string) => {
          if (code !== "TAR_ENTRY_INFO") skippedEntries += 1;
        },
        filter: (_path, entry) => {
          if (overLimit !== null) return false;
          const type = "type" in entry ? String(entry.type) : "File";
          if (!WRITABLE_TYPES.has(type)) {
            skippedEntries += 1;
            return false;
          }
          entries += 1;
          if (type !== "Directory" && type !== "SymbolicLink") {
            fileCount += 1;
            totalBytes += entry.size;
          }
          if (entries > MAX_ENTRIES || totalBytes > PROJECT_COPY_FOLDER_MAX_BYTES) {
            overLimit =
              entries > MAX_ENTRIES
                ? "The folder holds more files than a copy may unpack."
                : "The folder is larger than a copy may unpack.";
            source.destroy(new FolderArchiveError(overLimit));
            return false;
          }
          return true;
        },
      });
      await pipeline(source, unpack, { signal });
      if (overLimit !== null) throw new FolderArchiveError(overLimit);
      return { fileCount, totalBytes, skippedEntries };
    },
    catch: (cause) =>
      cause instanceof FolderArchiveError
        ? cause
        : new FolderArchiveError(
            `The folder could not be unpacked: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
  });
