/**
 * Reads a checkout's HEAD straight from disk, without spawning git.
 *
 * Supports the two layouts git creates for a working tree root: a `.git`
 * directory (main checkout) and a `.git` file pointing at the gitdir (linked
 * worktrees, submodules). Anything else — a folder below the root, a bare
 * repository, an unreadable layout — returns null so callers fall back to git.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

export interface CheckoutHead {
  /** The checked-out branch's short name; null while HEAD is detached. */
  readonly branch: string | null;
  /** The repository's shared metadata directory (holds refs/remotes). */
  readonly commonDir: string;
  /** `origin/HEAD`'s branch, the primary remote's default; null when unknown. */
  readonly originDefaultBranch: string | null;
}

const readText = (filePath: string) => readFile(filePath, "utf8").catch(() => null);

async function resolveGitDir(checkoutRoot: string): Promise<string | null> {
  const dotGit = path.join(checkoutRoot, ".git");
  const pointer = await readText(dotGit);
  if (pointer !== null) {
    // `.git` is a file: `gitdir: <path>`, relative to the checkout.
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
    return match?.[1] ? path.resolve(checkoutRoot, match[1]) : null;
  }
  // A directory reads as an error; it is the gitdir when it holds HEAD.
  return (await readText(path.join(dotGit, "HEAD"))) === null ? null : dotGit;
}

export function parseHeadFile(contents: string): { readonly branch: string | null } | null {
  const trimmed = contents.trim();
  const symbolic = /^ref:\s*refs\/heads\/(.+)$/.exec(trimmed);
  // Reftable repositories keep a placeholder HEAD file (`refs/heads/.invalid`)
  // and store the real HEAD in the reftable: only git can answer.
  if (symbolic?.[1] === ".invalid") return null;
  if (symbolic?.[1]) return { branch: symbolic[1] };
  // A detached HEAD holds an object id.
  return /^[0-9a-f]{40,64}$/i.test(trimmed) ? { branch: null } : null;
}

async function readCheckoutHeadAsync(checkoutRoot: string): Promise<CheckoutHead | null> {
  const gitDir = await resolveGitDir(checkoutRoot);
  if (gitDir === null) return null;
  const headContents = await readText(path.join(gitDir, "HEAD"));
  const head = headContents === null ? null : parseHeadFile(headContents);
  if (head === null) return null;
  const commonDirPointer = await readText(path.join(gitDir, "commondir"));
  const commonDir = commonDirPointer?.trim()
    ? path.resolve(gitDir, commonDirPointer.trim())
    : gitDir;
  // Symbolic refs are never packed, so origin/HEAD is always a loose file.
  const originHead = await readText(path.join(commonDir, "refs", "remotes", "origin", "HEAD"));
  const originDefaultBranch =
    /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec(originHead?.trim() ?? "")?.[1] ?? null;
  return { branch: head.branch, commonDir, originDefaultBranch };
}

export const readCheckoutHead = (checkoutRoot: string): Effect.Effect<CheckoutHead | null> =>
  Effect.promise(() => readCheckoutHeadAsync(checkoutRoot).catch(() => null));
