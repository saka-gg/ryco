/**
 * Persisted repository identity: the JSON stored in `projection_projects` (migration 086) and the
 * cheap fingerprint that says when it must be resolved again.
 *
 * Shell snapshots and project lookups read the stored identity and never wait on `git`;
 * `repositoryIdentitySync.ts` keeps it current in the background.
 *
 * @module RepositoryIdentityPersistence
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { RepositoryIdentity } from "@ryco/contracts";
import { Option, Schema } from "effect";

const decodeRepositoryIdentityJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RepositoryIdentity),
);
const encodeRepositoryIdentity = Schema.encodeSync(RepositoryIdentity);

/** The stored identity, or null when none is stored or it no longer decodes (a cache, never fatal). */
export function decodePersistedRepositoryIdentity(json: string | null): RepositoryIdentity | null {
  if (json === null) return null;
  return Option.getOrNull(decodeRepositoryIdentityJson(json));
}

/** The column value for an identity; null for "not a repository / no remote". */
export function encodePersistedRepositoryIdentity(
  identity: RepositoryIdentity | null,
): string | null {
  return identity === null ? null : JSON.stringify(encodeRepositoryIdentity(identity));
}

/** Whether two stored values describe the same identity, regardless of how they were written. */
export function samePersistedRepositoryIdentity(
  left: string | null,
  right: string | null,
): boolean {
  return (
    encodePersistedRepositoryIdentity(decodePersistedRepositoryIdentity(left)) ===
    encodePersistedRepositoryIdentity(decodePersistedRepositoryIdentity(right))
  );
}

const statOrNull = (target: string) => stat(target).catch(() => null);

/** `<gitdir>` named by a `.git` file (linked worktrees, submodules), resolved against its folder. */
async function readGitDirFile(dotGitFile: string): Promise<string | null> {
  const content = await readFile(dotGitFile, "utf8").catch(() => null);
  const match = content === null ? null : /^gitdir:\s*(.+)$/m.exec(content);
  const gitDir = match?.[1]?.trim();
  return gitDir ? path.resolve(path.dirname(dotGitFile), gitDir) : null;
}

/** A linked worktree's shared repository directory (`commondir`), or the git dir itself. */
async function resolveCommonDir(gitDir: string): Promise<string> {
  const content = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null);
  const commonDir = content?.trim();
  return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
}

/**
 * A cheap revalidation key for a workspace root's repository identity, read with a few `stat`
 * calls and no process spawn. The identity comes from the repository's remotes, which live in
 * `<commonDir>/config`, so the key is the enclosing repository's location plus that file's size
 * and modification time; `none` when no repository encloses the root.
 *
 * Returns null when the root itself is missing: an unavailable root is skipped, and its last
 * known identity is kept.
 */
export async function readRepositoryIdentityFingerprint(
  workspaceRoot: string,
): Promise<string | null> {
  const root = await statOrNull(workspaceRoot);
  if (root === null || !root.isDirectory()) return null;
  let directory = path.resolve(workspaceRoot);
  for (;;) {
    const dotGit = path.join(directory, ".git");
    const entry = await statOrNull(dotGit);
    const gitDir =
      entry === null ? null : entry.isDirectory() ? dotGit : await readGitDirFile(dotGit);
    if (gitDir !== null) {
      const configPath = path.join(await resolveCommonDir(gitDir), "config");
      const config = await statOrNull(configPath);
      return `git:${directory}|${configPath}|${config === null ? "missing" : `${config.size}:${config.mtimeMs}`}`;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "none";
    directory = parent;
  }
}
