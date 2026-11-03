import { resolveWorkspaceImageReference } from "@ryco/client-runtime/state/files";

/**
 * A Markdown image source as a path inside the workspace at `cwd`, or null.
 * `baseDirectory` is where relative sources resolve (a rendered document's own
 * folder); it defaults to `cwd`, and the result always stays inside `cwd`.
 */
export function resolveMarkdownWorkspaceImagePath(
  source: string | undefined,
  cwd: string | undefined,
  baseDirectory?: string,
): string | null {
  return cwd ? resolveWorkspaceImageReference(source, { workspaceRoot: cwd, baseDirectory }) : null;
}

export function isSafeRemoteMarkdownImageSource(source: string | undefined): boolean {
  if (!source) return false;
  const trimmed = source.trim();
  return (
    /^https:\/\//i.test(trimmed) ||
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)
  );
}
