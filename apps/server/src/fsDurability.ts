import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

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

/**
 * Replaces `filePath` through a fresh temp file next to it and a rename, so a reader sees the
 * old contents or the new ones, never a half-written file. The promise-based twin of
 * `writeFileAtomically` (`atomicWrite.ts`).
 *
 * - `mode`: the file's permission bits, set exactly (the umask cannot narrow them) before the
 *   rename. Windows only keeps the read-only bit, so it is not set there.
 * - `durable`: flushes the file before the rename and the directory after it.
 *
 * The directory must exist. On failure the temp file is removed and the error is rethrown.
 */
export async function replaceFileAtomically(input: {
  readonly filePath: string;
  readonly contents: string | Uint8Array;
  readonly mode?: number;
  readonly durable?: boolean;
}): Promise<void> {
  const temporaryPath = `${input.filePath}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      input.mode ?? 0o666,
    );
    if (input.mode !== undefined && process.platform !== "win32") await file.chmod(input.mode);
    await file.writeFile(input.contents);
    if (input.durable === true) await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, input.filePath);
  } catch (error: unknown) {
    await file?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  if (input.durable === true) await syncDirectory(dirname(input.filePath));
}
