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

async function canonicalFolder(folder: string): Promise<string | null> {
  if (folder.length === 0 || !path.isAbsolute(folder)) return null;
  try {
    const canonical = await realpath(folder);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}
