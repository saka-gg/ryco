/**
 * Git `.git` pointer files. A linked worktree or a submodule has a `.git` file
 * instead of a directory, holding one `gitdir: <path>` line. Pure: callers read
 * the file themselves, so this works without git on `PATH` and ignores
 * `GIT_DIR`.
 */

/**
 * The `gitdir:` target of a `.git` pointer file, as written (it may be
 * relative to the checkout), or `undefined` when the content is not a pointer.
 */
export function parseGitDirPointer(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("gitdir:")) continue;
    const target = trimmed.slice("gitdir:".length).trim();
    return target.length > 0 ? target : undefined;
  }
  return undefined;
}

/**
 * Whether a git directory sits where git keeps linked worktrees':
 * `<common dir>/worktrees/<name>`. The common dir need not be called `.git` (a
 * bare repository's is `<repo>.git`), so this matches the `worktrees/<name>`
 * tail. A submodule's (`.git/modules/<name>`) does not match, unless the
 * submodule itself is checked out at `…/worktrees/<name>`. This is a quick
 * filter on the path alone; to be sure, also check that the git dir holds the
 * `commondir` file git writes for every linked worktree, pointing at its
 * parent's parent. Accepts `\` separators.
 */
export function isLinkedWorktreeGitDir(gitDir: string): boolean {
  const segments = gitDir
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments[segments.length - 2] === "worktrees";
}
