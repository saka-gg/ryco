import { resolveWorkspaceRelativePath } from "@ryco/client-runtime/state/files";

const SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function stripQueryAndFragment(value: string): string {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  const boundary = [query, fragment]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), value.length);
  return value.slice(0, boundary);
}

function fileUrlPath(source: string): string | null {
  try {
    const url = new URL(source);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    const decoded = decodePath(url.pathname);
    if (!decoded) return null;
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

export function resolveMarkdownWorkspaceImagePath(
  source: string | undefined,
  cwd: string | undefined,
): string | null {
  if (!source || !cwd) return null;
  const trimmed = source.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  const scheme = WINDOWS_ABSOLUTE_PATTERN.test(trimmed)
    ? undefined
    : trimmed.match(SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (scheme && scheme !== "file") return null;

  const decodedSource =
    scheme === "file" ? fileUrlPath(trimmed) : decodePath(stripQueryAndFragment(trimmed));
  if (!decodedSource) return null;

  return resolveWorkspaceRelativePath(decodedSource, cwd);
}

export function isSafeRemoteMarkdownImageSource(source: string | undefined): boolean {
  if (!source) return false;
  const trimmed = source.trim();
  return (
    /^https:\/\//i.test(trimmed) ||
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)
  );
}
