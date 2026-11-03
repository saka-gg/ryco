import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Durability helpers for files that must survive a crash or power loss once written: flush a
 * file's data before it is renamed into place, then flush the directory so the rename itself is
 * on disk.
 *
 * @module fsDurability
 */

/** Flushes a file's data and metadata to disk. */
export async function syncFile(path: string): Promise<void> {
  // Writable on purpose: Windows refuses to flush a read-only handle.
  const file = await open(path, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * Flushes a directory, which makes a rename, link or unlink inside it durable. Windows cannot
 * open a directory for this and flushes directory entries itself, so it is a no-op there.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
