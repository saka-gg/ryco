import {
  assertStorageCleanupClaim,
  validateStorageCleanupClaim,
  type StorageCleanupClaim,
} from "./cleanupClaim.ts";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runProcess } from "../processRunner.ts";

export interface ScanBudget {
  remaining: number;
  deadline: number;
}
interface ManifestEntry {
  relativePath: string;
  stat: Stats;
}
export interface MeasuredSize {
  bytes: number | null;
  sizeStatus: "complete" | "bounded" | "unknown";
  unsafe: boolean;
  fingerprint?: string;
  manifest?: readonly ManifestEntry[];
}

/** Apparent bytes, with a shared node-wide budget; never follows links or mounts. */
export async function measureDirectory(
  root: string,
  budget: ScanBudget,
  excluded: ReadonlySet<string> = new Set(),
  captureManifest = false,
  rootCtime?: number,
): Promise<MeasuredSize> {
  let bytes = 0;
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
      if (captureManifest) {
        manifest.push({ relativePath: path.relative(root, current), stat });
        identities.push(
          JSON.stringify([
            path.relative(root, current),
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
      if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) {
        unsafe = true;
        bounded = true;
        continue;
      }
      if (path.basename(current) === ".git" && current !== path.join(root, ".git")) {
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
    return {
      bytes,
      sizeStatus: bounded ? "bounded" : "complete",
      unsafe,
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

async function readSmallFile(candidate: string): Promise<string> {
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error("Invalid git ownership file.");
  const handle = await fs.open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
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

async function assertWorktreeUnlocked(gitDirectory: string): Promise<void> {
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

/** Fresh status includes ignored files; an ignored archive may still be real user work. */
export async function assertCleanWorktree(candidate: string, repository: string): Promise<void> {
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
      "--ignored",
      "--ignore-submodules=none",
    ],
    {
      cwd: candidate,
      timeoutMs: 5000,
      maxBufferBytes: 256 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.stdout.length !== 0)
    throw new Error("Dirty, untracked or ignored files are protected.");
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
}

/** Quarantine first; never recursively delete a tree that external writers can extend.
 * Only entries from the post-rename manifest are considered. Each file is atomically
 * moved to a unique slot and rechecked before unlink; unknown children make rmdir fail.
 * Failures deliberately preserve the quarantine and its contents for manual recovery.
 */
export async function removeQuarantinedTemporaryDirectory(
  source: string,
  quarantine: string,
  expectedFingerprint: string,
  validateQuarantine?: (candidate: string) => Promise<void>,
  assertAdmission?: () => void,
): Promise<void> {
  const budget = () => ({ remaining: 30_000, deadline: Date.now() + 3000 });
  await assertCanonicalPath(source);
  await assertCanonicalPath(path.dirname(quarantine));
  const before = await measureDirectory(source, budget(), new Set(), true);
  if (!before.manifest || before.fingerprint !== expectedFingerprint)
    throw new Error("Temporary data changed at the removal boundary; preserved at " + source);
  const originalRoot = before.manifest.find((entry) => entry.relativePath === "")!.stat;
  // Destination names are unique and outside every producer allocation. Do not
  // overwrite a previous recovery directory, even on an interrupted attempt.
  try {
    await fs.lstat(quarantine);
    throw new Error("Cleanup quarantine already exists.");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  assertAdmission?.();
  await fs.rename(source, quarantine);
  try {
    await assertCanonicalPath(quarantine);
    const after = await measureDirectory(
      quarantine,
      budget(),
      new Set(),
      true,
      originalRoot.ctimeMs,
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
    const directories = after.manifest.filter((entry) => entry.stat.isDirectory());
    const directoryIdentities = new Map(
      directories.map((entry) => [path.join(quarantine, entry.relativePath), entry.stat]),
    );
    const removalBudget = budget();
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
    // No discovered-at-delete-time traversal: newly introduced entries are never
    // selected, followed or removed. File moves keep replacements at the old name.
    for (const entry of after.manifest.filter((item) => item.stat.isFile())) {
      const candidate = path.join(quarantine, entry.relativePath);
      await assertParents(candidate);
      const current = await fs.lstat(candidate);
      if (!sameFile(current, entry.stat) || current.ctimeMs !== entry.stat.ctimeMs)
        throw new Error("Quarantined file changed before removal.");
      const slot = path.join(quarantine, `.verified-${crypto.randomUUID()}`);
      assertAdmission?.();
      await fs.rename(candidate, slot);
      const moved = await fs.lstat(slot);
      // rename changes ctime; identity, type, links, bytes and mtime must still match.
      if (!sameFile(moved, entry.stat))
        throw new Error("Quarantined file changed at the file removal boundary.");
      await assertParents(slot);
      const final = await fs.lstat(slot);
      if (!sameFile(final, moved) || final.ctimeMs !== moved.ctimeMs)
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
    throw new Error(
      `Storage cleanup interrupted; remaining data preserved at ${quarantine}: ${cause instanceof Error ? cause.message : "filesystem changed"}`,
      { cause },
    );
  }
}

export interface VerifiedWorktreeCleanup {
  readonly quarantinePath: string;
  readonly fingerprint: string;
  readonly identity: WorktreeIdentity;
  readonly claim: StorageCleanupClaim;
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
  const identityJSON = JSON.stringify(cleanup.identity);
  await validateStorageCleanupClaim(
    claim,
    repository,
    candidate,
    quarantinePath,
    fingerprint,
    identityJSON,
  );
  if (
    path.dirname(quarantinePath) !== path.dirname(candidate) ||
    !path.basename(quarantinePath).startsWith(".cleanup-")
  )
    throw new Error("Invalid worktree cleanup quarantine.");
  const identity = await captureWorktreeIdentity(repository, candidate);
  if (JSON.stringify(identity) !== identityJSON)
    throw new Error("Worktree identity changed at the removal boundary.");
  await assertCleanWorktree(candidate, repository);
  await removeQuarantinedTemporaryDirectory(
    candidate,
    quarantinePath,
    fingerprint,
    async (quarantine) => {
      await validateStorageCleanupClaim(
        claim,
        repository,
        candidate,
        quarantinePath,
        fingerprint,
        identityJSON,
      );
      await assertCleanWorktree(quarantine, repository);
    },
    () => assertStorageCleanupClaim(claim),
  );
}
