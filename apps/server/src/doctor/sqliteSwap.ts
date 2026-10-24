/**
 * sqliteSwap - the file-system side of `ryco doctor`'s copy-and-swap: where the compacted copy
 * is written, how much room the volume has, making the copy durable, and the rename.
 *
 * The copy is written next to the database (`state.sqlite.doctor-<pid>-<epochMs>.tmp`), so the
 * rename stays on one volume (atomic on APFS and ext4) and the space check measures the volume
 * that receives it. Stale copies of an interrupted run are removed by exact name, only once the
 * doctor owns the database.
 *
 * @module sqliteSwap
 */
import { open, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import * as NodePath from "node:path";

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** `<dbPath>.doctor-<pid>-<epochMs>.tmp` */
export const doctorCopyPath = (dbPath: string, pid: number, epochMs: number): string =>
  `${dbPath}.doctor-${pid}-${epochMs}.tmp`;

/** Matches a doctor copy of `dbPath` (and SQLite's side files of one), nothing else. */
export const doctorCopyNamePattern = (dbPath: string): RegExp =>
  new RegExp(
    `^${escapeRegExp(NodePath.basename(dbPath))}\\.doctor-\\d+-\\d+\\.tmp(?:-journal|-wal|-shm)?$`,
    "u",
  );

/** Removes copies an interrupted doctor run left next to `dbPath`; returns their names. */
export async function removeStaleDoctorCopies(dbPath: string): Promise<ReadonlyArray<string>> {
  const pattern = doctorCopyNamePattern(dbPath);
  const directory = NodePath.dirname(dbPath);
  const removed: Array<string> = [];
  for (const name of await readdir(directory)) {
    if (!pattern.test(name)) continue;
    await rm(NodePath.join(directory, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** Removes a copy and the side files SQLite may have left next to it. Never fails. */
export async function removeDoctorCopy(copyPath: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    await rm(`${copyPath}${suffix}`, { force: true }).catch(() => undefined);
  }
}

/** Removes a file; a missing one is fine, any other error is thrown. */
export const removeFileIfPresent = (path: string): Promise<void> => rm(path, { force: true });

/** Bytes this user may still write on the volume holding `directory`. */
export async function freeBytesOnVolume(directory: string): Promise<number> {
  const info = await statfs(directory);
  return Number(info.bavail) * Number(info.bsize);
}

/** A file's size, 0 when it does not exist. */
export const fileSize = (path: string): Promise<number> =>
  stat(path).then(
    (info) => info.size,
    () => 0,
  );

/** The database file itself when `dbPath` is a link to it (the swap must replace the target). */
export const resolveDatabaseFile = (dbPath: string): Promise<string> =>
  realpath(dbPath).catch(() => NodePath.resolve(dbPath));

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Gives the copy the database's owner, group and permission bits, and makes its contents durable
 * (`VACUUM INTO` does not sync its output). A doctor run through `sudo` writes a root-owned copy:
 * swapped in as it is, the user's own server could no longer write the database. Changing the
 * owner needs root, so a run that cannot match it fails here, before the swap.
 */
export async function prepareCopyForSwap(copyPath: string, databasePath: string): Promise<void> {
  const database = await stat(databasePath);
  const handle = await open(copyPath, "r+");
  try {
    const copy = await handle.stat();
    if (copy.uid !== database.uid || copy.gid !== database.gid) {
      await handle.chown(database.uid, database.gid);
    }
    await handle.chmod(database.mode & 0o7777);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Renames the copy over the database and makes the rename durable. Only a failed rename throws
 * (the database is then unchanged); once it is renamed, a failed directory sync is returned
 * instead. Directories cannot be opened for an fsync on Windows; there the rename is all there is.
 */
export async function swapInCopy(
  copyPath: string,
  databasePath: string,
): Promise<{ readonly syncError: string | null }> {
  await rename(copyPath, databasePath);
  if (process.platform === "win32") return { syncError: null };
  try {
    await syncDirectory(NodePath.dirname(databasePath));
    return { syncError: null };
  } catch (cause) {
    return { syncError: cause instanceof Error ? cause.message : String(cause) };
  }
}
