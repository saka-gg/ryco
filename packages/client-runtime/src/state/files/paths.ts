import { isWindowsAbsolutePath } from "@ryco/shared/path";

import { normalizeWorkspaceRelativePath, WORKSPACE_FILE_PATH_MAX_LENGTH } from "./relativePath.ts";

export {
  normalizeWorkspaceRelativePath,
  WORKSPACE_FILE_PATH_MAX_LENGTH,
  workspaceFileBasename,
} from "./relativePath.ts";

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
 *
 * The result was resolved and contained here, so it is checked structurally,
 * not with `normalizeWorkspaceRelativePath`'s guesses about input it cannot
 * resolve: a `~assets` or `C:x` directory inside the root stays reachable.
 * Only the exact home forms (`~`, `~/…`) are still refused.
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
  // `normalizeAbsolutePath` already dropped empty, `.` and `..` segments.
  const relative = candidate.slice(prefix.length);
  if (relative.length === 0 || relative.length > WORKSPACE_FILE_PATH_MAX_LENGTH) return null;
  return relative === "~" || relative.startsWith("~/") ? null : relative;
}

/**
 * Where `workspaceRoot` sits inside `repositoryRoot`, as a relative `a/b`
 * prefix: "" when it is the repository root itself, null when it is not
 * inside it (or either is not an absolute path).
 */
export function workspacePathWithinRepository(
  workspaceRoot: string,
  repositoryRoot: string,
): string | null {
  const workspace = normalizeAbsolutePath(workspaceRoot);
  const repository = normalizeAbsolutePath(repositoryRoot);
  if (!workspace || !repository) return null;
  const caseInsensitive = WINDOWS_DRIVE_ROOT_PATTERN.test(repository);
  const comparable = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  if (comparable(workspace) === comparable(repository)) return "";
  return resolveWorkspaceRelativePath(workspace, repository);
}

/**
 * A repository-relative path (a git diff's) as a path inside the workspace
 * folder at `workspacePrefix` (from `workspacePathWithinRepository`), or null
 * when the file lies outside that folder.
 */
export function repositoryPathToWorkspacePath(
  repositoryPath: string,
  workspacePrefix: string,
): string | null {
  const path = normalizeWorkspaceRelativePath(repositoryPath);
  if (path === null || workspacePrefix.length === 0) return path;
  return path.startsWith(`${workspacePrefix}/`) ? path.slice(workspacePrefix.length + 1) : null;
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
