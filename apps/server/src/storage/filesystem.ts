import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { REGULAR_FILE_READ_FLAGS } from "@ryco/shared/regularFile";
import { runProcess } from "../processRunner.ts";

export interface ScanBudget {
  remaining: number;
  deadline: number;
}
interface ManifestEntry {
  relativePath: string;
  stat: Stats;
  /** A cache folder recorded by identity only: never traversed, moved out whole. */
  opaque?: true;
}
export interface MeasuredSize {
  bytes: number | null;
  sizeStatus: "complete" | "bounded" | "unknown";
  unsafe: boolean;
  /** Entries visited (files, directories and the root); all of them when complete. */
  entries?: number;
  fingerprint?: string;
  manifest?: readonly ManifestEntry[];
}

/** How a checkout's removal manifest treats what a clean `git status` vouches for. */
export interface CheckoutManifestOptions {
  /**
   * Cache folders, relative to the measured root: each is one manifest entry recorded by
   * identity (path, device, inode, mode), never traversed and its bytes not counted. Each must
   * be a plain directory on the root's device, and all of them must be present, or the result
   * is unsafe. Contents may change; replacing the folder changes the fingerprint.
   */
  readonly opaque?: ReadonlySet<string>;
  /**
   * Symbolic links are leaves: removal unlinks the link itself and never follows it. Only for a
   * checkout whose status is clean, so every link is tracked and unchanged (Ryco's own
   * `CLAUDE.md` is one); anywhere else a link makes the result unsafe.
   */
  readonly linkLeaves?: boolean;
}

/**
 * The manifest options of a checkout whose clean status lists these cache folders. Not on
 * Windows, where a directory junction looks like a link but `unlink` cannot remove it.
 */
export const checkoutManifest = (cacheFolders: readonly string[]): CheckoutManifestOptions => ({
  opaque: new Set(cacheFolders),
  linkLeaves: process.platform !== "win32",
});

/** Most cache folders one checkout's removal moves out (Ryco itself has 15). */
export const MAX_CACHE_FOLDERS = 256;

/**
 * Most entries (files, directories and the root) one quarantined removal takes on; a checkout
 * of Ryco without dependencies has about 8,700. Bigger trees stay protected instead of being
 * cut off half-way through their removal.
 */
export const MAX_QUARANTINE_REMOVAL_ENTRIES = 12_000;

/**
 * The removal's own budget grows with its manifest. It checks every file against its parents
 * twice: measured at 0.5 to 6 ms per entry on an 18-core Mac, the slow end at load average 30
 * with other processes busy on the same disk. 3 s plus 20 ms per entry only stops a stalled
 * filesystem: running out leaves a half-removed quarantine for manual recovery, so a slow one
 * must be allowed to finish.
 */
export const quarantineRemovalBudget = (entries: number, now = Date.now()): ScanBudget => ({
  // Parent checks: two per file, one per directory.
  remaining: 3 * entries + 16,
  deadline: now + 3_000 + 20 * entries,
});

/**
 * Entries a check of cache folders' contents may visit (`storage/cacheFolders.ts`): per scan,
 * shared by its candidates, or per entry when one is previewed, retained or removed. A checkout
 * of Ryco holds about 170,000 in its `node_modules` folders.
 */
export const cacheCheckBudget = (now = Date.now()): ScanBudget => ({
  remaining: 2_000_000,
  deadline: now + 30_000,
});

/** Apparent bytes, with a shared node-wide budget; never follows links or mounts. */
export async function measureDirectory(
  root: string,
  budget: ScanBudget,
  excluded: ReadonlySet<string> = new Set(),
  captureManifest = false,
  rootCtime?: number,
  options: CheckoutManifestOptions = {},
): Promise<MeasuredSize> {
  let bytes = 0;
  let entries = 0;
  let opaqueFound = 0;
  const identities: string[] = [];
  const manifest: ManifestEntry[] = [];
  let unsafe = false;
  let bounded = false;
  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink()) return { bytes: null, sizeStatus: "unknown", unsafe: true };
    const pending = [root];
    while (pending.length > 0) {
      if (budget.remaining-- <= 0 || Date.now() >= budget.deadline) {
        bounded = true;
        break;
      }
      const current = pending.pop()!;
      if (current !== root && excluded.has(current)) continue;
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch {
        bounded = true;
        continue;
      }
      entries++;
      const relativePath = path.relative(root, current);
      if (current !== root && options.opaque?.has(relativePath)) {
        opaqueFound++;
        if (captureManifest) {
          manifest.push({ relativePath, stat, opaque: true });
          identities.push(JSON.stringify([relativePath, stat.dev, stat.ino, "opaque", stat.mode]));
        }
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== rootStat.dev) {
          unsafe = true;
          bounded = true;
        }
        continue;
      }
      if (captureManifest) {
        manifest.push({ relativePath, stat });
        identities.push(
          JSON.stringify([
            relativePath,
            stat.dev,
            stat.ino,
            stat.size,
            stat.mtimeMs,
            current === root ? (rootCtime ?? stat.ctimeMs) : stat.ctimeMs,
            stat.mode,
            stat.nlink,
          ]),
        );
      }
      if (path.basename(current) === ".git" && current !== path.join(root, ".git")) {
        unsafe = true;
        bounded = true;
        continue;
      }
      if (
        stat.isSymbolicLink() &&
        options.linkLeaves &&
        current !== root &&
        stat.dev === rootStat.dev &&
        stat.nlink === 1
      ) {
        bytes += stat.size;
        continue;
      }
      if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) {
        unsafe = true;
        bounded = true;
        continue;
      }
      if (!stat.isDirectory()) {
        if (!stat.isFile() || stat.nlink > 1) {
          unsafe = true;
          bounded = true;
          continue;
        }
        bytes += stat.size;
        continue;
      }
      // Streaming directory entries avoids unbounded readdir allocations.
      try {
        if ((await fs.realpath(current)) !== current) {
          unsafe = true;
          bounded = true;
          continue;
        }
        const directory = await fs.opendir(current);
        const opened = await fs.lstat(current);
        if (opened.isSymbolicLink() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          await directory.close();
          unsafe = true;
          bounded = true;
          continue;
        }
        for await (const entry of directory) {
          if (budget.remaining-- <= 0 || Date.now() >= budget.deadline) {
            bounded = true;
            break;
          }
          if (pending.length >= 4096) {
            bounded = true;
            break;
          }
          pending.push(path.join(current, entry.name));
        }
      } catch {
        bounded = true;
      }
    }
    // A recorded cache folder that is gone (or was never there) is not the checkout we checked.
    if (!bounded && opaqueFound !== (options.opaque?.size ?? 0)) unsafe = true;
    return {
      bytes,
      sizeStatus: bounded ? "bounded" : "complete",
      unsafe,
      entries,
      ...(captureManifest && !bounded && !unsafe
        ? {
            manifest,
            fingerprint: createHash("sha256")
              .update(identities.toSorted().join("\n"))
              .digest("hex"),
          }
        : {}),
    };
  } catch {
    return { bytes: null, sizeStatus: "unknown", unsafe: true };
  }
}

/** A canonical path alone is insufficient: every current ancestor must remain link-free. */
export async function assertCanonicalPath(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  if ((await fs.realpath(resolved)) !== resolved)
    throw new Error("Path is an alias or contains a symbolic link.");
  let current = resolved;
  for (;;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are protected.");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

export async function readSmallFile(candidate: string): Promise<string> {
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error("Invalid git ownership file.");
  const handle = await fs.open(candidate, REGULAR_FILE_READ_FLAGS);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size > 4096
    )
      throw new Error("Git ownership file changed.");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const current = await fs.lstat(candidate);
    if (
      bytesRead > 4096 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new Error("Git ownership file changed during validation.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function assertWorktreeUnlocked(gitDirectory: string): Promise<void> {
  try {
    await fs.lstat(path.join(gitDirectory, "locked"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  throw new Error("Locked Git worktrees are protected.");
}

export interface WorktreeIdentity {
  device: number;
  inode: number;
  gitFile: string;
  gitDirectory: string;
  commonDirectory: string;
  commonDevice: number;
  commonInode: number;
}

export async function captureWorktreeIdentity(
  repository: string,
  candidate: string,
): Promise<WorktreeIdentity> {
  await assertCanonicalPath(repository);
  await assertCanonicalPath(candidate);
  if (repository === candidate || repository.startsWith(candidate + path.sep))
    throw new Error("Repository roots are protected.");
  const root = await fs.lstat(candidate);
  if (!root.isDirectory()) throw new Error("Worktree is not a directory.");
  const gitFile = await readSmallFile(path.join(candidate, ".git"));
  const match = /^gitdir: (.+)\r?\n?$/.exec(gitFile);
  if (!match) throw new Error("Only linked git worktrees are eligible.");
  const gitDirectory = await assertCanonicalPath(path.resolve(candidate, match[1]!));
  await assertWorktreeUnlocked(gitDirectory);
  const backlink = (await readSmallFile(path.join(gitDirectory, "gitdir"))).trim();
  if (path.resolve(gitDirectory, backlink) !== path.join(candidate, ".git"))
    throw new Error("Git worktree backlink does not match.");
  const commonDirectory = await assertCanonicalPath(
    path.resolve(gitDirectory, (await readSmallFile(path.join(gitDirectory, "commondir"))).trim()),
  );
  if (path.dirname(gitDirectory) !== path.join(commonDirectory, "worktrees"))
    throw new Error("Worktree metadata is outside its repository.");
  const actualCommon = await runProcess(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: repository,
      timeoutMs: 5000,
      maxBufferBytes: 4096,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if ((await fs.realpath(actualCommon.stdout.trim())) !== commonDirectory)
    throw new Error("Repository identity changed.");
  const common = await fs.lstat(commonDirectory);
  return {
    device: root.dev,
    inode: root.ino,
    gitFile,
    gitDirectory,
    commonDirectory,
    commonDevice: common.dev,
    commonInode: common.ino,
  };
}

/**
 * A cache folder a checkout's removal moves out whole, before anything is deleted, to a
 * Ryco-named sibling of the checkout; the ledger records it so the background purge deletes
 * exactly that folder (`storage/cacheFolders.ts`).
 */
export interface CacheMove {
  /** Inside the checkout, e.g. `apps/web/node_modules`. */
  readonly relativePath: string;
  /** `<quarantine>-cache-<n>`, beside the checkout. */
  readonly destination: string;
  readonly device: number;
  readonly inode: number;
}

/** The destination of a checkout's `index`-th cache folder. */
export const cacheMoveDestination = (quarantine: string, index: number) =>
  `${quarantine}-cache-${index}`;

/**
 * Where a removal recorded in a ledger row's identity put things: its quarantine (a
 * `.cleanup-*` sibling of `checkout`) and its cache moves, each at exactly the destination that
 * removal uses (`<quarantine>-cache-<n>`). Null when the record says anything else, so neither
 * admission fencing nor the cache purge ever trusts a path the removal did not choose.
 */
export function readRemovalRecord(
  checkout: string,
  identity: unknown,
): { readonly quarantine: string; readonly caches: readonly CacheMove[] } | null {
  const record = identity as { quarantinePath?: unknown; caches?: unknown } | null;
  const quarantine = record?.quarantinePath;
  if (
    typeof quarantine !== "string" ||
    !path.isAbsolute(quarantine) ||
    path.dirname(quarantine) !== path.dirname(checkout) ||
    !path.basename(quarantine).startsWith(".cleanup-")
  )
    return null;
  const caches = record?.caches ?? [];
  if (!Array.isArray(caches) || caches.length > MAX_CACHE_FOLDERS) return null;
  const moves: CacheMove[] = [];
  for (const [index, value] of (caches as unknown[]).entries()) {
    const move = value as Partial<CacheMove> | null;
    if (
      typeof move?.relativePath !== "string" ||
      move.destination !== cacheMoveDestination(quarantine, index) ||
      typeof move.device !== "number" ||
      typeof move.inode !== "number"
    )
      return null;
    moves.push({
      relativePath: move.relativePath,
      destination: move.destination,
      device: move.device,
      inode: move.inode,
    });
  }
  return { quarantine, caches: moves };
}
