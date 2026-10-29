/**
 * The quarantined removal of a checkout or of completed staging data, and the status check a
 * checkout must pass first. Only storage cleanup removes anything, on request or on a retention
 * pass, so this loads with import() and stays off the server's boot path.
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseWorktreeStatus } from "@ryco/shared/workspaceLifecycle";
import { runProcess } from "../processRunner.ts";
import {
  checkoutChangeBlockers,
  ignoredCacheDirectories,
  splitUnattendedCacheFolders,
  withoutEmptyIgnoredDirectories,
  withRegenerableByOwnNameOnly,
} from "../workspace/checkoutStatus.ts";
import {
  assertStorageCleanupClaim,
  validateStorageCleanupClaim,
  type StorageCleanupClaim,
} from "./cleanupClaim.ts";
import {
  assertCanonicalPath,
  assertWorktreeUnlocked,
  cacheMoveDestination,
  captureWorktreeIdentity,
  checkoutManifest,
  MAX_CACHE_FOLDERS,
  MAX_QUARANTINE_REMOVAL_ENTRIES,
  measureDirectory,
  quarantineRemovalBudget,
  readSmallFile,
  type CacheMove,
  type WorktreeIdentity,
} from "./filesystem.ts";

export interface RemovableWorktree {
  /**
   * Cache folders to move out whole (`node_modules`, `apps/web/node_modules`, `.venv`),
   * relative to the checkout, sorted. Their contents are checked separately
   * (`storage/cacheFolders.ts`): `git status` lists such a folder as one entry.
   */
  readonly cacheFolders: readonly string[];
}

/**
 * Fresh status with ignored files, classified by the shared rule (`classifyIgnoredPath`, the
 * one the workspace lifecycle uses) in its unattended form (`withRegenerableByOwnNameOnly`):
 * modified, untracked and ignored files that are not a known cache (credentials, databases,
 * unknown outputs) keep the checkout, with the lifecycle's own reasons. Ignored files that are
 * regenerable by their own name (`*.tsbuildinfo`, `.DS_Store`) are ordinary entries of the
 * removal manifest. Ignored dependency and tool cache folders (`node_modules/`, `.venv/`,
 * `.turbo/`) are returned to be moved out whole; ignored build output (`dist/`, `build/`) keeps
 * the checkout, and so does every cache folder on Windows, where moving them is untested.
 * Throws the reasons when the checkout is not removable.
 */
export async function assertRemovableWorktree(
  candidate: string,
  repository: string,
): Promise<RemovableWorktree> {
  const gitFile = await readSmallFile(path.join(candidate, ".git"));
  const match = /^gitdir: (.+)\r?\n?$/.exec(gitFile);
  if (!match) throw new Error("Only linked Git worktrees are eligible.");
  await assertWorktreeUnlocked(path.resolve(candidate, match[1]!));
  const result = await runProcess(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // One entry per ignored folder instead of every file in it: a checkout with
      // dependencies stays within the output bound and answers in milliseconds.
      "--ignored=matching",
      "--ignore-submodules=none",
    ],
    {
      cwd: candidate,
      timeoutMs: 5000,
      maxBufferBytes: 256 * 1024,
      outputMode: "truncate",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  const status = await withoutEmptyIgnoredDirectories(
    candidate,
    withRegenerableByOwnNameOnly(parseWorktreeStatus(result.stdout)),
    { includeRegenerable: true },
  );
  const blockers = checkoutChangeBlockers({
    ...status,
    truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
  });
  const folders = ignoredCacheDirectories(status);
  const { unattended, reviewedOnly } =
    process.platform === "win32"
      ? { unattended: [], reviewedOnly: folders }
      : splitUnattendedCacheFolders(folders);
  if (reviewedOnly.length > 0)
    blockers.push(
      `Ignored build output is protected (${reviewedOnly.slice(0, 3).join(", ")}). Remove checkout on the Projects page can delete it.`,
    );
  if (unattended.length > MAX_CACHE_FOLDERS) blockers.push("Too many cache folders to verify.");
  if (blockers.length > 0) throw new Error(blockers.join(" "));
  const base = await runProcess("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repository,
    timeoutMs: 5000,
    maxBufferBytes: 4096,
  });
  const unmerged = await runProcess("git", ["rev-list", "--count", `${base.stdout.trim()}..HEAD`], {
    cwd: candidate,
    timeoutMs: 5000,
    maxBufferBytes: 4096,
  });
  if (unmerged.stdout.trim() !== "0")
    throw new Error(
      "Unmerged branch history is protected; merge into project HEAD before cleanup.",
    );
  // Even clean initialized submodules may own unpublished commits. Git removal is not a recursive cleanup tool.
  try {
    await fs.lstat(path.join(candidate, ".gitmodules"));
    throw new Error("Submodule worktrees are protected.");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return { cacheFolders: unattended };
}

/** Quarantine first; never recursively delete a tree that external writers can extend.
 * Only entries from the post-rename manifest are considered. Each file is atomically
 * moved to a unique slot and rechecked before unlink; unknown children make rmdir fail.
 * Failures deliberately preserve the quarantine and its contents for manual recovery.
 *
 * `checkout` is set for a Git checkout whose clean status vouches for its contents: links are
 * unlinked as leaves, and each cache folder listed there is moved out whole (its identity
 * pinned by the fingerprint) to its recorded destination before anything is deleted.
 */
export async function removeQuarantinedTemporaryDirectory(
  source: string,
  quarantine: string,
  expectedFingerprint: string,
  validateQuarantine?: (candidate: string) => Promise<void>,
  assertAdmission?: () => void,
  checkout?: { readonly caches: readonly CacheMove[] },
): Promise<void> {
  // Measurements at the boundary: the entry bound is the scan's, but time only guards against a
  // stalled filesystem, because running out after the claim leaves a manual recovery.
  const budget = () => ({ remaining: 30_000, deadline: Date.now() + 30_000 });
  const caches = checkout?.caches ?? [];
  const manifestOptions = checkout
    ? checkoutManifest(caches.map((cache) => cache.relativePath))
    : {};
  await assertCanonicalPath(source);
  await assertCanonicalPath(path.dirname(quarantine));
  if (
    new Set(caches.map((cache) => cache.destination)).size !== caches.length ||
    caches.some((cache, index) => cache.destination !== cacheMoveDestination(quarantine, index))
  )
    throw new Error("Invalid cache folder destination; nothing was moved.");
  const before = await measureDirectory(
    source,
    budget(),
    new Set(),
    true,
    undefined,
    manifestOptions,
  );
  if (!before.manifest || before.fingerprint !== expectedFingerprint)
    throw new Error("Temporary data changed at the removal boundary; preserved at " + source);
  if (before.manifest.length > MAX_QUARANTINE_REMOVAL_ENTRIES)
    throw new Error("Too many files to remove safely in one pass; nothing was moved.");
  const originalRoot = before.manifest.find((entry) => entry.relativePath === "")!.stat;
  // Destination names are unique and outside every producer allocation. Do not
  // overwrite a previous recovery directory, even on an interrupted attempt.
  for (const destination of [quarantine, ...caches.map((cache) => cache.destination)])
    try {
      await fs.lstat(destination);
      throw new Error("Cleanup quarantine already exists.");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  assertAdmission?.();
  await fs.rename(source, quarantine);
  // Cache folders already moved out: manual recovery needs them back in the quarantine.
  let movedCaches = 0;
  try {
    await assertCanonicalPath(quarantine);
    const after = await measureDirectory(
      quarantine,
      budget(),
      new Set(),
      true,
      originalRoot.ctimeMs,
      manifestOptions,
    );
    if (!after.manifest || after.fingerprint !== expectedFingerprint)
      throw new Error("Temporary data changed during quarantine; no entries were deleted.");
    if (validateQuarantine) await validateQuarantine(quarantine);
    const sameIdentity = (a: Stats, b: Stats) =>
      !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
    const sameFile = (a: Stats, b: Stats) =>
      sameIdentity(a, b) &&
      a.isFile() &&
      a.nlink === 1 &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs;
    const sameLink = (a: Stats, b: Stats) =>
      a.isSymbolicLink() &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.mode === b.mode &&
      a.nlink === 1 &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs;
    const manifest = after.manifest;
    // Cache folders were recorded by identity only and leave whole; everything else is checked
    // entry by entry below, so they are not in these lists.
    const directories = manifest.filter((entry) => entry.stat.isDirectory() && !entry.opaque);
    const directoryIdentities = new Map(
      directories.map((entry) => [path.join(quarantine, entry.relativePath), entry.stat]),
    );
    const removalBudget = quarantineRemovalBudget(manifest.length);
    const assertParents = async (candidate: string) => {
      if (removalBudget.remaining-- <= 0 || Date.now() >= removalBudget.deadline)
        throw new Error("Quarantine removal budget exhausted.");
      await assertCanonicalPath(candidate);
      let parent = directoryIdentities.has(candidate) ? candidate : path.dirname(candidate);
      for (;;) {
        const expected = directoryIdentities.get(parent);
        if (!expected || !sameIdentity(await fs.lstat(parent), expected))
          throw new Error("Quarantine directory identity changed.");
        if (parent === quarantine) break;
        parent = path.dirname(parent);
      }
    };
    // Cache folders leave first, whole and unread, each to its recorded destination: the
    // folder must be the very directory the fingerprint pinned (same device and inode, not a
    // link), so a swapped-in folder or link is never moved, followed or deleted. All of them
    // are checked before the first one moves, and each again right before its move.
    const assertCacheIdentity = async (cache: CacheMove) => {
      const recorded = manifest.find(
        (entry) => entry.opaque && entry.relativePath === cache.relativePath,
      )?.stat;
      if (
        !recorded ||
        !recorded.isDirectory() ||
        recorded.dev !== cache.device ||
        recorded.ino !== cache.inode ||
        !sameIdentity(await fs.lstat(path.join(quarantine, cache.relativePath)), recorded)
      )
        throw new Error("Cache folder identity changed.");
      return recorded;
    };
    for (const cache of caches) await assertCacheIdentity(cache);
    for (const cache of caches) {
      const candidate = path.join(quarantine, cache.relativePath);
      const recorded = await assertCacheIdentity(cache);
      await assertParents(candidate);
      assertAdmission?.();
      await fs.rename(candidate, cache.destination);
      movedCaches++;
      if (!sameIdentity(await fs.lstat(cache.destination), recorded))
        throw new Error("Cache folder changed while it was moved.");
    }
    // No discovered-at-delete-time traversal: newly introduced entries are never
    // selected, followed or removed. File moves keep replacements at the old name.
    for (const entry of manifest.filter(
      (item) => item.stat.isFile() || (checkout && item.stat.isSymbolicLink()),
    )) {
      const candidate = path.join(quarantine, entry.relativePath);
      const link = entry.stat.isSymbolicLink();
      const same = link ? sameLink : sameFile;
      // A link is checked through its folder: resolving the link itself would follow it.
      await assertParents(link ? path.dirname(candidate) : candidate);
      const current = await fs.lstat(candidate);
      if (!same(current, entry.stat) || current.ctimeMs !== entry.stat.ctimeMs)
        throw new Error("Quarantined file changed before removal.");
      const slot = path.join(quarantine, `.verified-${crypto.randomUUID()}`);
      assertAdmission?.();
      await fs.rename(candidate, slot);
      const moved = await fs.lstat(slot);
      // rename changes ctime; identity, type, links, bytes and mtime must still match.
      if (!same(moved, entry.stat))
        throw new Error("Quarantined file changed at the file removal boundary.");
      await assertParents(link ? quarantine : slot);
      const final = await fs.lstat(slot);
      if (!same(final, moved) || final.ctimeMs !== moved.ctimeMs)
        throw new Error("Quarantined file changed during final validation.");
      assertAdmission?.();
      await fs.unlink(slot);
    }
    for (const entry of directories.toSorted(
      (a, b) => b.relativePath.length - a.relativePath.length,
    )) {
      const candidate = path.join(quarantine, entry.relativePath);
      await assertParents(candidate);
      // Non-recursive rmdir refuses unexpected entries added during deletion.
      assertAdmission?.();
      await fs.rmdir(candidate);
    }
  } catch (cause) {
    const moved =
      movedCaches === 0
        ? ""
        : ` (cache folders moved beside it: ${caches
            .slice(0, movedCaches)
            .map((cache) => `${cache.relativePath} to ${cache.destination}`)
            .join(", ")})`;
    throw new Error(
      `Storage cleanup interrupted; remaining data preserved at ${quarantine}${moved}: ${cause instanceof Error ? cause.message : "filesystem changed"}`,
      { cause },
    );
  }
}

export interface VerifiedWorktreeCleanup {
  readonly quarantinePath: string;
  readonly fingerprint: string;
  readonly identity: WorktreeIdentity;
  readonly claim: StorageCleanupClaim;
  /** Cache folders the claim records; moved out whole, deleted by the background purge. */
  readonly caches?: readonly CacheMove[];
  /** Compatibility only; callers cannot supply admission authority. */
  readonly assertAdmission?: () => void;
}

/** Cleanup never delegates checkout traversal to git worktree remove. Its status
 * check omits ignored files and may honor showUntrackedFiles=no. Keep registration,
 * refs and history; explicitly pruning the missing registration is a separate action.
 */
export async function removeVerifiedWorktree(
  repository: string,
  candidate: string,
  cleanup: VerifiedWorktreeCleanup,
): Promise<void> {
  const { quarantinePath, fingerprint, claim } = cleanup;
  const caches = cleanup.caches ?? [];
  const identityJSON = JSON.stringify(cleanup.identity);
  const cachesJSON = JSON.stringify(caches);
  const validateClaim = () =>
    validateStorageCleanupClaim(
      claim,
      repository,
      candidate,
      quarantinePath,
      fingerprint,
      identityJSON,
      cachesJSON,
    );
  // The cache folders a fresh status lists must be exactly the claimed ones.
  const assertRemovable = async (checkout: string) => {
    const { cacheFolders } = await assertRemovableWorktree(checkout, repository);
    if (JSON.stringify(cacheFolders) !== JSON.stringify(caches.map((cache) => cache.relativePath)))
      throw new Error("Cache folders changed at the removal boundary.");
  };
  await validateClaim();
  if (
    path.dirname(quarantinePath) !== path.dirname(candidate) ||
    !path.basename(quarantinePath).startsWith(".cleanup-")
  )
    throw new Error("Invalid worktree cleanup quarantine.");
  const identity = await captureWorktreeIdentity(repository, candidate);
  if (JSON.stringify(identity) !== identityJSON)
    throw new Error("Worktree identity changed at the removal boundary.");
  await assertRemovable(candidate);
  await removeQuarantinedTemporaryDirectory(
    candidate,
    quarantinePath,
    fingerprint,
    async (quarantine) => {
      await validateClaim();
      await assertRemovable(quarantine);
    },
    () => assertStorageCleanupClaim(claim),
    { caches },
  );
}
