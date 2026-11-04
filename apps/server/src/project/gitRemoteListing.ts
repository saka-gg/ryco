/**
 * Reads `git remote -v` output and picks the remote a repository's identity comes from. A leaf
 * module, so the cross-node copy's export (`projectCopy/exportGit.ts`, loaded through `import()`)
 * shares it without a static import of the identity resolver layer, which would split boot
 * modules into extra boot chunks.
 *
 * @module project/gitRemoteListing
 */
import { pickIdentityRemoteName } from "@ryco/shared/gitRemoteUrl";

/** The fetch URL of every remote in `git remote -v` output, by remote name in listing order. */
export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

/** The named remote with its fetch URL; null for no name or a remote without a URL. */
export function remoteNamed(
  remotes: ReadonlyMap<string, string>,
  remoteName: string | null,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const remoteUrl = remoteName === null ? undefined : remotes.get(remoteName);
  return remoteName !== null && remoteUrl ? { remoteName, remoteUrl } : null;
}

/**
 * The remote a repository's identity comes from (`pickIdentityRemoteName`: `upstream`, then
 * `origin`, then the first by name). A cross-node copy clones from `pickCloneRemoteName` instead.
 */
export function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  return remoteNamed(remotes, pickIdentityRemoteName([...remotes.keys()]));
}
