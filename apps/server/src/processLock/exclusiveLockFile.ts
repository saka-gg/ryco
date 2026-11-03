/**
 * A lock file that exists while one process holds it.
 *
 * `O_CREAT | O_EXCL` makes creation the arbitration: of two processes creating
 * the same path at once, exactly one succeeds. Readers classify what they find
 * without ever deleting something they did not judge: an abandoned lock is
 * removed only while it is still the file that was judged (same inode), and
 * its reclaimers take turns, so none removes a lock another one just created
 * in its place. Shared by the Hub identity lock and the database owner lock;
 * each brings its own record format and liveness policy.
 *
 * @module exclusiveLockFile
 */
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readFile, rm } from "node:fs/promises";

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
 * recognizably not the original. It is called with 0 when the filesystem does
 * not keep the inode still.
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
    if (typeof contents === "string") await handle.writeFile(contents);
    else await writeNamingInode(handle, contents);
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
 * Write `contents(ino)` naming the inode every later stat reports. exFAT and FAT
 * on macOS report a placeholder inode (2^64 - 1) for an empty file and the real
 * one once it holds data, so the file gets data before its inode is read. A
 * record naming the placeholder would make every reader, the holder included,
 * judge the live lock a copy and take it over.
 */
async function writeNamingInode(
  handle: FileHandle,
  contents: (ino: number) => string,
): Promise<void> {
  // Unparseable, like an empty file: readers see a lock that is being written.
  let written = await overwrite(handle, " ", 0);
  const ino = (await handle.stat()).ino;
  written = await overwrite(handle, contents(ino), written);
  // Still moving: name none rather than a wrong one, which skips copy detection.
  if ((await handle.stat()).ino !== ino) await overwrite(handle, contents(0), written);
}

/**
 * Replace the file's `previousBytes` with `text`, in place: never emptied, which
 * would free a FAT file's first cluster and move its inode again.
 */
async function overwrite(handle: FileHandle, text: string, previousBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  const { bytesWritten } = await handle.write(bytes, 0, bytes.length, 0);
  if (bytesWritten !== bytes.length) {
    throw new Error(`Wrote ${bytesWritten} of ${bytes.length} bytes of a lock file`);
  }
  if (bytes.length < previousBytes) await handle.truncate(bytes.length);
  return bytes.length;
}

const isJudgedFile = (current: Stats, judged: LockFileIdentity): boolean =>
  current.isFile() &&
  current.ino === judged.ino &&
  (judged.mtimeMs === undefined || current.mtimeMs === judged.mtimeMs);

/**
 * Remove this process's own lock file only if it is still the one that was
 * judged: same inode and, when known, the same modification time. False when
 * another file took its place; true when it is gone either way. A lock another
 * process left behind is removed with {@link reclaimLockFile} instead.
 */
export async function removeLockFileIfUnchanged(
  path: string,
  judged: LockFileIdentity,
): Promise<boolean> {
  try {
    if (!isJudgedFile(await lstat(path), judged)) return false;
    await rm(path);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  }
}

export type LockFileReclaim = "removed" | "replaced" | "busy";

/**
 * Remove a lock file that was judged abandoned: "removed" once it is gone,
 * "replaced" when another file took its place since, "busy" while another
 * process is reclaiming it.
 *
 * Checking the file and removing it are two steps, so reclaimers take turns:
 * each holds the guard `<path>.reclaim`, created exclusively, from its check
 * to its removal. Otherwise, of two processes that judged the same lock
 * abandoned, the slower one could remove the lock the faster one had just
 * created in its place, and both would hold it. Creating a lock needs no
 * guard: it only succeeds where no file is. A guard left by a reclaimer that
 * died holding it is removed once `isGuardStale(its modification time)`.
 *
 * Throws when the lock or the guard cannot be removed or created (a read-only
 * directory): the abandoned lock stays, and retrying would never end.
 */
export async function reclaimLockFile(
  path: string,
  judged: LockFileIdentity,
  isGuardStale: (mtimeMs: number) => boolean,
): Promise<LockFileReclaim> {
  const guardPath = `${path}.reclaim`;
  if (!(await createLockFileExclusive(guardPath, "", { sync: false }))) {
    const guard = await lstat(guardPath).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (guard?.isFile() && isGuardStale(guard.mtimeMs)) {
      await removeLockFileIfUnchanged(guardPath, guard);
    }
    return "busy";
  }
  try {
    let current: Stats;
    try {
      current = await lstat(path);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return "removed";
      throw error;
    }
    if (!isJudgedFile(current, judged)) return "replaced";
    await rm(path, { force: true });
    return "removed";
  } finally {
    await rm(guardPath, { force: true });
  }
}
