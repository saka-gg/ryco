// Loaded with `import()` from `SessionImport.discover`, so it stays off the
// server's boot path.
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * The folder each recorded conversation folder resolves to on this node: its
 * real path when it is an existing directory, null when it is empty, not an
 * absolute path here, gone, or not a directory. Project import groups
 * conversations by this, so two spellings of one folder (a symlink, a trailing
 * separator) share a group, and a new project is only proposed for a folder
 * that exists. Each distinct folder is resolved once.
 */
export async function canonicalCandidateFolders(
  folders: Iterable<string>,
): Promise<ReadonlyMap<string, string | null>> {
  const unique = [...new Set(folders)];
  const resolved = await Promise.all(unique.map(canonicalFolder));
  return new Map(unique.map((folder, index) => [folder, resolved[index] ?? null]));
}

/** A folder on an unreachable network mount must not stall a discovery page. */
const FOLDER_RESOLVE_TIMEOUT_MS = 1_000;

async function canonicalFolder(folder: string): Promise<string | null> {
  if (folder.length === 0 || !path.isAbsolute(folder)) return null;
  // A UNC path (`\\host\share`) would reach out over the network from a Windows node.
  if (/^[\\/]{2}[^\\/]/u.test(folder)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FOLDER_RESOLVE_TIMEOUT_MS);
  });
  const lookup = (async () => {
    try {
      const canonical = await realpath(folder);
      return (await stat(canonical)).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
