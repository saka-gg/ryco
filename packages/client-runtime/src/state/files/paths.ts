import { isWindowsAbsolutePath } from "@ryco/shared/path";

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

const WINDOWS_DRIVE_ROOT_PATTERN = /^([A-Za-z]:)\//;

/** `/a/b/../c` → `/a/c`; null for relative, UNC or root-escaping paths. */
function normalizeAbsolutePath(value: string): string | null {
  const slashPath = value.replaceAll("\\", "/");
  const drive = WINDOWS_DRIVE_ROOT_PATTERN.exec(slashPath)?.[1];
  if ((!slashPath.startsWith("/") && drive === undefined) || slashPath.startsWith("//")) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of slashPath.slice(drive ? drive.length + 1 : 1).split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${drive ? `${drive}/` : "/"}${segments.join("/")}`;
}

/**
 * A path (an agent's file link, a markdown image) as a path inside
 * `workspaceRoot`, or null when it addresses anything outside it. Absolute
 * paths must sit under the root (case-insensitively on a Windows drive);
 * relative ones resolve against it and may not walk out of it.
 */
export function resolveWorkspaceRelativePath(path: string, workspaceRoot: string): string | null {
  if (path.length === 0 || path.includes("\0")) return null;
  const root = normalizeAbsolutePath(workspaceRoot);
  if (!root) return null;
  const isAbsolute = path.startsWith("/") || path.startsWith("\\") || isWindowsAbsolutePath(path);
  const candidate = normalizeAbsolutePath(isAbsolute ? path : `${root}/${path}`);
  if (!candidate) return null;
  const caseInsensitive = WINDOWS_DRIVE_ROOT_PATTERN.test(root);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const comparable = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  if (!comparable(candidate).startsWith(comparable(prefix))) return null;
  return normalizeWorkspaceRelativePath(candidate.slice(prefix.length));
}

export function workspaceFileBasename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

export function workspaceFileParentPath(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return null;
  return segments.slice(0, -1).join("/");
}

/**
 * Reads a file path out of route params. Navigation hands back either the
 * `:path*` segment array or a single string, already percent-decoded, so this
 * only rejoins and normalizes.
 */
export function routeFilePathParam(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  const joined = typeof value === "string" ? value : value.join("/");
  return normalizeWorkspaceRelativePath(joined);
}

export function relativePathToRouteSegments(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** Line anchors are only meaningful as 1-based positive integers; anything else is dropped. */
export function routeLineParam(value: string | readonly string[] | undefined): number | null {
  if (value === undefined) return null;
  const first = typeof value === "string" ? value : value[0];
  if (first === undefined || first.trim().length === 0) return null;
  const parsed = Number(first);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
