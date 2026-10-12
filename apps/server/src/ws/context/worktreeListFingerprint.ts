/**
 * A cheap fingerprint of a repository's worktree registrations, so the worktree
 * reconciliation sweep runs `git worktree list` only for repositories whose
 * registrations changed since the last successful pass.
 *
 * `git worktree list` reports the main checkout plus one entry per directory
 * under `<common dir>/worktrees/`, whose `gitdir` file holds the checkout path.
 * Adding, removing, pruning or moving a worktree creates, deletes or rewrites
 * those, so the fingerprint is the common dir, the entry names, and each
 * entry's `gitdir` size and mtime. It is read with a handful of `stat` calls
 * instead of the three `rev-parse` spawns and the list itself.
 *
 * Any doubt (no `.git`, an unreadable or unexpected layout) returns `null`,
 * which never matches: the sweep then asks git as before.
 *
 * @module worktreeListFingerprint
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Resolves `<root>/.git` to the repository's common git directory. */
async function commonGitDirectory(root: string): Promise<string | null> {
  const dotGit = path.join(root, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) return null;
  // A linked worktree (or submodule): `.git` is a file naming its git dir.
  const pointer = (await readFile(dotGit, "utf8")).trim();
  if (!pointer.startsWith("gitdir:")) return null;
  const gitDir = path.resolve(root, pointer.slice("gitdir:".length).trim());
  try {
    const common = (await readFile(path.join(gitDir, "commondir"), "utf8")).trim();
    return path.resolve(gitDir, common);
  } catch {
    return gitDir;
  }
}

export async function readWorktreeListFingerprint(root: string): Promise<string | null> {
  try {
    const located = await commonGitDirectory(root);
    if (located === null) return null;
    // One spelling per repository, however the checkout was reached.
    const commonDir = await realpath(located);
    const worktreesDir = path.join(commonDir, "worktrees");
    let names: string[];
    try {
      names = (await readdir(worktreesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return `${commonDir}\u0000-`;
      return null;
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const gitdir = await stat(path.join(worktreesDir, name, "gitdir"));
          return `${name}:${gitdir.size}:${gitdir.mtimeMs}`;
        } catch {
          return `${name}:-`;
        }
      }),
    );
    return [commonDir, ...entries].join("\u0000");
  } catch {
    return null;
  }
}
