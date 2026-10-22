import { isWindowsAbsolutePath } from "@ryco/shared/path";

// A leaf of its own: composer drafts check and label the paths of their file
// references at boot, and the rest of `paths.ts` is not needed there.

/**
 * Mirrors the contracts cap on `ProjectReadFileInput.relativePath`. A longer
 * path can never round-trip to the node, so it is rejected client-side instead
 * of being sent and bounced.
 */
export const WORKSPACE_FILE_PATH_MAX_LENGTH = 512;

/**
 * Reduces a workspace-relative path to the canonical `a/b/c` form the node
 * accepts, or null when the value cannot address anything inside the root.
 *
 * Rejection (rather than clamping) is deliberate: `..` that walks past the root,
 * absolute/UNC/drive paths and `~` expansions are all escape attempts, and a
 * hostile or buggy node listing must not be able to steer a read outside the
 * workspace the user opened.
 */
export function normalizeWorkspaceRelativePath(value: string): string | null {
  if (value.length === 0) return null;
  if (value.startsWith("~")) return null;
  if (isWindowsAbsolutePath(value)) return null;
  // Drive-RELATIVE forms ("C:x", no separator after the colon) escape the shared
  // predicate above but resolve against the drive's current directory on a
  // Windows node — outside the root just as surely as "C:\x".
  if (/^[A-Za-z]:/.test(value)) return null;

  const unified = value.replaceAll("\\", "/");
  if (unified.startsWith("/")) return null;

  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return null;
  const joined = segments.join("/");
  return joined.length > WORKSPACE_FILE_PATH_MAX_LENGTH ? null : joined;
}

export function workspaceFileBasename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}
