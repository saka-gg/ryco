/**
 * Cache folders (`node_modules/`, `.venv/`, `.turbo/`) of checkouts that storage cleanup removes.
 * `git status` lists such a folder as one entry, so its contents are checked here: before the
 * checkout is claimed (a finding keeps the checkout), and again before the background purge
 * deletes the folder after the removal moved it out (a finding keeps the folder, deleting
 * nothing in it). Loaded with import(): only checkouts that hold cache folders need it.
 */
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { StorageError } from "@ryco/contracts";
import { isUserSecretFileName } from "@ryco/shared/workspaceLifecycle";
import {
  assertCanonicalPath,
  readRemovalRecord,
  type CacheMove,
  type ScanBudget,
} from "./filesystem.ts";

/**
 * One row's purge: a read-only pass, then the deletion, each visiting every entry once (twice
 * `cacheCheckBudget`'s entries); what is left resumes on a later pass.
 */
export const cachePurgeBudget = (now = Date.now()): ScanBudget => ({
  remaining: 4_000_000,
  deadline: now + 300_000,
});

/** A cache folder as a check saw it: the removal must move exactly this directory. */
export interface CheckedCacheFolder {
  readonly relativePath: string;
  readonly device: number;
  readonly inode: number;
}

export interface CacheFolderCheck {
  /**
   * The folders whose contents were checked, in order, by the identity they had when the walk
   * started; complete only when `complete` and no `finding`.
   */
  readonly folders: readonly CheckedCacheFolder[];
  /** Entries visited inside the folders. */
  readonly entries: number;
  /** Apparent bytes of the files and links inside, as far as the sizing budget lasted. */
  readonly bytes: number;
  /** Whether `bytes` covers everything inside (a sizing budget was given and lasted). */
  readonly sized: boolean;
  /** Why the folders are not only caches; null when nothing was found. */
  readonly finding: string | null;
  /** False when the budget ran out before everything was checked. */
  readonly complete: boolean;
}

/** Most directories a walk keeps waiting to be read (Ryco's dependencies hold about 16,000). */
const PENDING_DIRECTORIES = 100_000;

type EntryKind = "directory" | "file" | "link" | "other";
const kindOf = async (entry: Dirent, entryPath: string): Promise<[EntryKind, Stats | null]> => {
  if (entry.isFile()) return ["file", null];
  if (entry.isSymbolicLink()) return ["link", null];
  if (entry.isSocket() || entry.isFIFO() || entry.isBlockDevice() || entry.isCharacterDevice())
    return ["other", null];
  // A directory (or an entry whose type the listing does not tell) is looked at itself: a
  // directory must be a real one on the cache folder's device.
  const stat = await fs.lstat(entryPath);
  return [
    stat.isSymbolicLink()
      ? "link"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other",
    stat,
  ];
};

/**
 * What in a cache folder is not a cache: a nested Git repository (an editable install's
 * checkout keeps local work), a socket, pipe or device, a mount, or a file named like a secret
 * a person put there (`.env`, an SSH key, `.npmrc`; see `isUserSecretFileName`). Null when
 * none; `entryPath` is shown relative to the checkout, under the folder's `label`.
 */
const findingFor = (
  label: string,
  relative: string,
  kind: EntryKind,
  name: string,
  stat: Stats | null,
  device: number,
): string | null => {
  const shown = `${label}/${relative}`;
  if (name === ".git") return `The cache folder ${label}/ holds a Git repository (${shown}).`;
  if (kind === "other")
    return `The cache folder ${label}/ holds a socket, pipe or device (${shown}).`;
  if (kind === "directory" && stat && stat.dev !== device)
    return `The cache folder ${label}/ reaches into another file system (${shown}).`;
  if (kind === "file" && isUserSecretFileName(name))
    return `The cache folder ${label}/ holds ${shown}, which is not a cache.`;
  return null;
};

/** A permission error: a root-owned, read-only or immutable entry stays until a person acts. */
const isPermissionError = (cause: unknown) => {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
};
/** Whether this process has `mode` access to `directory`; false on a permission error. */
const mayAccess = (directory: string, mode: number) =>
  fs.access(directory, mode).then(
    () => true,
    (cause: unknown) => {
      if (isPermissionError(cause)) return false;
      throw cause;
    },
  );

/**
 * Read-only walk of one cache folder; never follows links or crosses devices. Sizes are read
 * (one more `lstat` per file) while `sizing` lasts: running out of it only leaves the size a
 * lower bound, while running out of `budget` leaves the check incomplete. The folder must be
 * one this process can delete: moving it to another folder needs write access to it and to its
 * parent, and emptying it needs read, write and search access to every folder inside. A
 * read-only or root-owned one (left by a container, say) would fail only after the checkout
 * was quarantined.
 */
async function inspectCacheFolder(
  folder: string,
  label: string,
  budget: ScanBudget,
  sizing: ScanBudget | null,
): Promise<CacheFolderCheck> {
  const root = await fs.lstat(folder);
  if (root.isSymbolicLink() || !root.isDirectory())
    return {
      folders: [],
      entries: 0,
      bytes: 0,
      sized: false,
      finding: `The cache folder ${label}/ is not a plain folder.`,
      complete: true,
    };
  const folders = [{ relativePath: label, device: root.dev, inode: root.ino }];
  let entries = 0;
  let bytes = 0;
  let sized = sizing !== null;
  const undeletable = (directory: string): CacheFolderCheck => ({
    folders,
    entries,
    bytes,
    sized: false,
    finding:
      directory === folder
        ? `Ryco cannot delete the cache folder ${label}/ (permission denied).`
        : `The cache folder ${label}/ holds a folder Ryco cannot delete (${label}/${path.relative(folder, directory)}).`,
    complete: true,
  });
  if (!(await mayAccess(path.dirname(folder), fsConstants.W_OK | fsConstants.X_OK)))
    return undeletable(folder);
  const pending = [folder];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (!(await mayAccess(directory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)))
      return undeletable(directory);
    const listing = await fs.opendir(directory);
    try {
      for await (const entry of listing) {
        if (budget.remaining-- <= 0 || Date.now() >= budget.deadline)
          return { folders, entries, bytes, sized: false, finding: null, complete: false };
        entries++;
        const entryPath = path.join(directory, entry.name);
        const [kind, known] = await kindOf(entry, entryPath);
        const finding = findingFor(
          label,
          path.relative(folder, entryPath),
          kind,
          entry.name,
          known,
          root.dev,
        );
        if (finding) return { folders, entries, bytes, sized: false, finding, complete: true };
        if (kind === "directory") {
          // Directories waiting to be read stay bounded however wide the tree is.
          if (pending.length >= PENDING_DIRECTORIES)
            return { folders, entries, bytes, sized: false, finding: null, complete: false };
          pending.push(entryPath);
        } else if (sized && sizing) {
          if (sizing.remaining-- <= 0 || Date.now() >= sizing.deadline) sized = false;
          else bytes += (known ?? (await fs.lstat(entryPath))).size;
        }
      }
    } finally {
      await listing.close().catch(() => undefined);
    }
  }
  return { folders, entries, bytes, sized, finding: null, complete: true };
}

/**
 * Checks a checkout's cache folders before it is claimed: any finding keeps the checkout.
 * With `sizing` (scans, display only) it also adds up their apparent size while it lasts.
 */
export async function checkCacheFolders(
  checkout: string,
  folders: readonly string[],
  budget: ScanBudget,
  sizing: ScanBudget | null,
): Promise<CacheFolderCheck> {
  const checked: CheckedCacheFolder[] = [];
  let entries = 0;
  let bytes = 0;
  let sized = sizing !== null;
  for (const folder of folders) {
    const check = await inspectCacheFolder(path.join(checkout, folder), folder, budget, sizing);
    checked.push(...check.folders);
    entries += check.entries;
    bytes += check.bytes;
    sized &&= check.sized;
    if (check.finding || !check.complete)
      return { ...check, folders: checked, entries, bytes, sized: false };
  }
  return { folders: checked, entries, bytes, sized, finding: null, complete: true };
}

export type CachePurgeOutcome = "done" | "budget" | { readonly kept: string };

/**
 * Deletes one cache folder the ledger recorded at its destination beside the removed checkout.
 * A read-only pass first: a finding keeps the whole folder (nothing in it is deleted). Then a
 * post-order deletion that unlinks files and links (never following one), descends only into
 * real directories on the folder's device, checks each directory's identity and canonical path
 * before reading and before `rmdir`, and stops (keeping the rest) at anything that changed, is
 * not a cache or may not be deleted. "budget": stopped; the next pass resumes. A folder that is
 * gone is done.
 */
export async function purgeCacheDirectory(
  move: CacheMove,
  budget: ScanBudget,
): Promise<CachePurgeOutcome> {
  let root: Stats;
  try {
    root = await fs.lstat(move.destination);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "done";
    throw cause;
  }
  const label = move.relativePath;
  const changed = {
    kept: `The cache folder ${label}/ changed after the checkout was removed; kept at ${move.destination}.`,
  };
  if (
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    root.dev !== move.device ||
    root.ino !== move.inode
  )
    return changed;
  await assertCanonicalPath(move.destination);
  const check = await inspectCacheFolder(move.destination, label, budget, null);
  if (check.finding)
    return { kept: `${check.finding} Kept at ${move.destination}; nothing in it was deleted.` };
  if (!check.complete) return "budget";
  const sameDirectory = async (directory: string, expected: Stats) => {
    const current = await fs.lstat(directory);
    return (
      !current.isSymbolicLink() &&
      current.isDirectory() &&
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      (await fs.realpath(directory)) === directory
    );
  };
  // Permissions that changed after the read-only pass: retrying would fail the same way.
  const denied = (target: string) => ({
    kept: `Ryco cannot delete ${path.join(label, path.relative(move.destination, target))} (permission denied); the rest of the cache folder ${label}/ is kept at ${move.destination}.`,
  });
  const removeDirectory = async (
    directory: string,
    expected: Stats,
  ): Promise<CachePurgeOutcome> => {
    // Entries that appear while it is emptied make rmdir fail; a few rounds, then a later pass.
    for (let round = 0; round < 3; round++) {
      if (!(await sameDirectory(directory, expected))) return changed;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (budget.remaining-- <= 0 || Date.now() >= budget.deadline) return "budget";
        const entryPath = path.join(directory, entry.name);
        const [kind, known] = await kindOf(entry, entryPath);
        const finding = findingFor(
          label,
          path.relative(move.destination, entryPath),
          kind,
          entry.name,
          known,
          root.dev,
        );
        if (finding) return { kept: `${finding} The rest is kept at ${move.destination}.` };
        if (kind === "directory") {
          const outcome = await removeDirectory(entryPath, known ?? (await fs.lstat(entryPath)));
          if (outcome !== "done") return outcome;
          continue;
        }
        try {
          await fs.unlink(entryPath);
        } catch (cause) {
          if (isPermissionError(cause)) return denied(entryPath);
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      if (!(await sameDirectory(directory, expected))) return changed;
      try {
        await fs.rmdir(directory);
        return "done";
      } catch (cause) {
        if (isPermissionError(cause)) return denied(directory);
        if ((cause as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw cause;
      }
    }
    return "budget";
  };
  return removeDirectory(move.destination, root);
}

const PURGE_ROWS = 64;
/** Failed passes after which a row's purge stops retrying and keeps what is left. */
const PURGE_ATTEMPTS = 3;

/**
 * Deletes the cache folders of removed checkouts (ledger rows `removing` with purge
 * `caches-only`), each row with its own budget. A row whose folders are all gone becomes
 * `removed`; a finding keeps its folders (purge `preserved`, the reason in `last_error`, shown
 * in Storage), and the row stays `removing`, as any interrupted cleanup does. So does a row
 * whose purge failed `PURGE_ATTEMPTS` times. Rows whose purge is still `planned` are
 * interrupted removals and are never touched. Rows whose last attempt failed come after the
 * others, so they never keep later removals waiting.
 */
export const purgePendingCacheFolders = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      path: string;
      identity_json: string;
    }>`SELECT id, path, identity_json FROM storage_owned_entries WHERE state = 'removing' AND json_extract(identity_json, '$.purge') = 'caches-only' ORDER BY last_error IS NOT NULL, id LIMIT ${PURGE_ROWS}`;
    for (const row of rows) {
      const identity = yield* Effect.try(
        () => JSON.parse(row.identity_json) as Record<string, unknown>,
      ).pipe(Effect.orElseSucceed(() => null));
      // Only folders at exactly the destinations this removal chose (`readRemovalRecord`).
      const moves = identity ? (readRemovalRecord(row.path, identity)?.caches ?? null) : null;
      const pending = sql`id = ${row.id} AND state = 'removing' AND json_extract(identity_json, '$.purge') = 'caches-only'`;
      if (!identity || !moves) {
        yield* sql`UPDATE storage_owned_entries SET last_error = ${"The record of its cache folders is unreadable; nothing was deleted."}, identity_json = json_set(identity_json, '$.purge', 'preserved') WHERE ${pending}`;
        continue;
      }
      const budget = cachePurgeBudget();
      let outcome: CachePurgeOutcome = "done";
      for (const move of moves) {
        const result = yield* Effect.tryPromise({
          try: () => purgeCacheDirectory(move, budget),
          catch: (cause) =>
            new StorageError({
              detail: cause instanceof Error ? cause.message : "Filesystem error.",
            }),
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("storage cleanup could not delete a cache folder", cause),
          ),
          Effect.result,
        );
        if (result._tag === "Failure") {
          const failures =
            (typeof identity.purgeFailures === "number" ? identity.purgeFailures : 0) + 1;
          if (failures >= PURGE_ATTEMPTS)
            outcome = {
              kept: `Deleting the cache folder ${move.relativePath}/ failed ${failures} times; what is left is kept at ${move.destination}. ${result.failure.detail}`,
            };
          else {
            yield* sql`UPDATE storage_owned_entries SET last_error = ${`Deleting the cache folder ${move.relativePath}/ failed; retrying later. ${result.failure.detail}`}, identity_json = json_set(identity_json, '$.purgeFailures', ${failures}) WHERE ${pending}`;
            outcome = "budget";
          }
          break;
        }
        outcome = result.success;
        if (outcome !== "done") break;
      }
      if (outcome === "done") {
        const { caches: _caches, purge: _purge, purgeFailures: _failures, ...rest } = identity;
        yield* sql`UPDATE storage_owned_entries SET state = 'removed', last_error = NULL, identity_json = ${JSON.stringify(rest)} WHERE ${pending}`;
      } else if (outcome !== "budget") {
        yield* sql`UPDATE storage_owned_entries SET last_error = ${outcome.kept}, identity_json = ${JSON.stringify({ ...identity, purge: "preserved" })} WHERE ${pending}`;
      }
    }
  });
