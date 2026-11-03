import { resolveWorkspaceRelativePath, workspaceFileParentPath } from "./paths.ts";

/**
 * Link and image references in rendered text (an agent's reply, a Markdown
 * file in the workspace) resolved to files. Pure string work shared by every
 * client: nothing here reads the filesystem or knows a platform.
 */

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const URL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

// ── Paths with a line/column suffix ──────────────────────────────────

/**
 * A drive path needs its separator (`C:/`, `C:\`): a bare `C:` in a link is a
 * URL scheme here, unlike `@ryco/shared/path`, which counts it as a drive.
 */
function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  if (!line) return resolvedPath;
  return `${resolvedPath}:${line}${column ? `:${column}` : ""}`;
}

// ── Markdown link targets ────────────────────────────────────────────

/** `decodeURIComponent`, or null for a malformed escape. */
function decodeUriComponentOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** A link keeps a malformed escape as it is written. */
function safeDecode(value: string): string {
  return decodeUriComponentOrNull(value) ?? value;
}

/** `value` up to its first `?` or `#`, and the `#…` fragment (empty without one). */
function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

/**
 * A `file:` URL's host, its still percent-encoded path, and its fragment; null
 * for any other URL. Each caller decides how to decode and which hosts to take.
 */
function parseFileUrl(
  href: string,
): { readonly host: string; readonly path: string; readonly hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const path = /^\/[A-Za-z]:[\\/]/.test(rawPath) ? rawPath.slice(1) : rawPath;
    return { host: parsed.hostname, path, hash: parsed.hash };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrl(href.trim());
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") && !isWindowsAbsolutePath(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(URL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = path.slice(match[0].length);
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

/**
 * A link's `href` as an absolute file path with an optional `:line:column`
 * suffix, or null when it is not a file reference (a URL, an anchor, an app
 * route). Relative paths resolve against `baseDirectory`; without one they are
 * not resolved.
 */
export function resolveFileLinkTarget(
  href: string | undefined,
  baseDirectory?: string,
): string | null {
  if (!href) return null;
  const rawHref = href.trim();
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrl = rawHref.toLowerCase().startsWith("file:") ? parseFileUrl(rawHref) : null;
  const source = fileUrl ?? stripSearchAndHash(rawHref);
  const decodedPath = fileUrl ? safeDecode(source.path).trim() : safeDecode(source.path.trim());
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (!isWindowsAbsolutePath(decodedPath) && hasExternalScheme(decodedPath)) return null;

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!baseDirectory) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDirectory);
}

// ── Workspace references ─────────────────────────────────────────────

/** A file an agent's link or a document names, inside one workspace. */
export interface WorkspaceFileReference {
  /** Workspace-relative, as `resolveWorkspaceRelativePath` returns it. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export interface WorkspaceReferenceScope {
  /** Containment, and what reads are relative to. */
  readonly workspaceRoot: string;
  /** Where relative references resolve; defaults to `workspaceRoot` (a document's own folder). */
  readonly baseDirectory?: string | undefined;
}

/** A link to a file anywhere on the node, and where that file is inside the workspace. */
export interface FileLinkReference {
  /** Absolute, with a `:line:column` suffix when the link names a position. */
  readonly targetPath: string;
  /** Absolute, without the suffix. */
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
  /** Workspace-relative; null outside the workspace or without a `workspaceRoot`. */
  readonly workspacePath: string | null;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * `href` (a markdown link, `path:12:3`, `#L12C3`, `file://…`) as a file, inside
 * the workspace or not: an editor can open either, Ryco's Files panel only the
 * first. Relative links resolve against `baseDirectory`, else `workspaceRoot`.
 */
export function resolveFileLinkReference(
  href: string | undefined,
  scope: {
    readonly workspaceRoot?: string | undefined;
    readonly baseDirectory?: string | undefined;
  },
): FileLinkReference | null {
  const targetPath = resolveFileLinkTarget(href, scope.baseDirectory ?? scope.workspaceRoot);
  if (!targetPath) return null;
  const { path, line, column } = splitPathAndPosition(targetPath);
  const lineNumber = positiveInt(line);
  const columnNumber = lineNumber === undefined ? undefined : positiveInt(column);
  return {
    targetPath,
    filePath: path,
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
    workspacePath: scope.workspaceRoot
      ? resolveWorkspaceRelativePath(path, scope.workspaceRoot)
      : null,
  };
}

/** `href` (a markdown link, `path:12:3`, `#L12C3`, `file://…`) as a file inside the workspace, or null. */
export function resolveWorkspaceFileReference(
  href: string | undefined,
  scope: WorkspaceReferenceScope,
): WorkspaceFileReference | null {
  const link = resolveFileLinkReference(href, scope);
  if (!link || link.workspacePath === null) return null;
  return {
    path: link.workspacePath,
    ...(link.line !== undefined ? { line: link.line } : {}),
    ...(link.column !== undefined ? { column: link.column } : {}),
  };
}

// ── Workspace images ─────────────────────────────────────────────────

/** A local `file:` image's decoded path; null for another host or a malformed escape. */
function fileUrlPath(source: string): string | null {
  const url = parseFileUrl(source);
  if (!url || (url.host && url.host !== "localhost")) return null;
  const decoded = decodeUriComponentOrNull(url.path);
  // An encoded drive (`/C%3A/…`) only reads as one once decoded.
  return decoded && /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/** An image source as a workspace-relative path, or null (remote, data:, outside the workspace). */
export function resolveWorkspaceImageReference(
  source: string | undefined,
  scope: WorkspaceReferenceScope,
): string | null {
  if (!source) return null;
  const trimmed = source.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  const scheme = isWindowsAbsolutePath(trimmed)
    ? undefined
    : trimmed.match(URL_SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme && scheme !== "file") return null;

  // Unlike a link, an image with a malformed escape names no file.
  const decodedSource =
    scheme === "file"
      ? fileUrlPath(trimmed)
      : decodeUriComponentOrNull(stripSearchAndHash(trimmed).path);
  if (!decodedSource) return null;

  const isAbsolute =
    decodedSource.startsWith("/") ||
    decodedSource.startsWith("\\") ||
    isWindowsAbsolutePath(decodedSource);
  if (isAbsolute || scope.baseDirectory === undefined) {
    return resolveWorkspaceRelativePath(decodedSource, scope.workspaceRoot);
  }
  return resolveWorkspaceRelativePath(
    `${trimTrailingSeparators(scope.baseDirectory)}/${decodedSource}`,
    scope.workspaceRoot,
  );
}

/** The folder a workspace file sits in, as an absolute path: `baseDirectory` for its relative references. */
export function workspaceFileFolder(workspaceRoot: string, relativePath: string): string {
  const parent = workspaceFileParentPath(relativePath);
  return parent === null ? workspaceRoot : `${trimTrailingSeparators(workspaceRoot)}/${parent}`;
}
