/**
 * A lock file that exists while one process holds it.
 *
 * `O_CREAT | O_EXCL` makes creation the arbitration: of two processes creating
 * the same path at once, exactly one succeeds. Readers classify what they find
 * without ever deleting something they did not judge, and removal checks that
 * the file is still the one that was judged (same inode). Shared by the Hub
 * identity lock and the database owner lock; each brings its own record format
 * and liveness policy.
 *
 * @module exclusiveLockFile
 */
import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";

import { errorCode } from "./processIdentity.ts";

/**
 * What tells the lock file that was judged from one created at the same path
 * since: the inode number, and the modification time, because a filesystem
 * may give a new file the inode number of the one just removed (ext4 does).
 */
export interface LockFileIdentity {
  readonly ino: number;
  /** Unknown for a file this process just created and never re-read. */
  readonly mtimeMs?: number | undefined;
}

export type LockFileRead<Record> =
  | { readonly kind: "absent" }
  /** Being written right now, or left half-written by a crash. */
  | { readonly kind: "unparseable"; readonly mtimeMs: number; readonly ino: number }
  /** Not something a lock writes (a directory, a symlink, an oversized file). Never removed. */
  | { readonly kind: "foreign"; readonly ino: number }
  /** Permission denied: often a lock written by another user's process. */
  | { readonly kind: "unreadable"; readonly code: string }
  | {
      readonly kind: "holder";
      readonly record: Record;
      readonly mtimeMs: number;
      readonly ino: number;
    };

const isPermissionError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM";
};

/**
 * Read and classify a lock file. Other I/O errors are thrown: the caller
 * decides whether an unusable lock location fails open or closed.
 */
export async function readLockFile<Record>(
  path: string,
  options: {
    readonly maxBytes: number;
    readonly decode: (content: string) => Record | undefined;
  },
): Promise<LockFileRead<Record>> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    if (isPermissionError(error)) return { kind: "unreadable", code: errorCode(error) ?? "EACCES" };
    throw error;
  }
  if (!stats.isFile() || stats.size > options.maxBytes) return { kind: "foreign", ino: stats.ino };
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    // Released, or reclaimed by a racing process, since the `lstat`: the path
    // is free, not unreadable — reporting it as an unusable lock would carry
    // on without one while the racing process takes it.
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    if (isPermissionError(error)) return { kind: "unreadable", code: errorCode(error) ?? "EACCES" };
    throw error;
  }
  const record = options.decode(content);
  return record === undefined
    ? { kind: "unparseable", mtimeMs: stats.mtimeMs, ino: stats.ino }
    : { kind: "holder", record, mtimeMs: stats.mtimeMs, ino: stats.ino };
}

/**
 * Create the lock file with `contents`, mode 0600, synced before it is closed
 * unless `sync: false`. False when it already exists. `contents` may depend on
 * the new file's inode, so a record can name the very file it was written
 * into: a copy of it (a copied data directory) then has another inode and is
 * recognizably not the original.
 *
 * Other processes read the contents at once either way; the sync only makes
 * them survive a power loss, which a lock whose holder did not survive either
 * rarely needs.
 */
export async function createLockFileExclusive(
  path: string,
  contents: string | ((ino: number) => string),
  options?: { readonly sync?: boolean },
): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    const text = typeof contents === "string" ? contents : contents((await handle.stat()).ino);
    await handle.writeFile(text);
    if (options?.sync !== false) await handle.sync();
  } catch (error: unknown) {
    // A half-written lock would hold the path for the unparseable grace
    // period; this process knows it is its own, so it removes it at once.
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

/**
 * Remove the lock file only if it is still the one that was judged: same inode
 * and, when known, the same modification time. False when another file took
 * its place; true when it is gone either way.
 */
export async function removeLockFileIfUnchanged(
  path: string,
  judged: LockFileIdentity,
): Promise<boolean> {
  try {
    const current = await lstat(path);
    if (
      current.ino !== judged.ino ||
      (judged.mtimeMs !== undefined && current.mtimeMs !== judged.mtimeMs) ||
      !current.isFile()
    ) {
      return false;
    }
    await rm(path);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  }
}
