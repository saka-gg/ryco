import { resolveFileLinkReference } from "@ryco/client-runtime/state/files";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

export {
  resolveFileLinkTarget as resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "@ryco/client-runtime/state/files";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  basename: string;
  line?: number;
  column?: number;
  /** The file inside the thread's workspace (`cwd`); null outside it or without a `cwd`. */
  workspacePath: string | null;
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

/**
 * `baseDirectory` is where relative links resolve (a rendered document's own
 * folder); it defaults to `cwd`. The display path stays relative to `cwd`.
 */
export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDirectory?: string,
): MarkdownFileLinkMeta | null {
  const link = resolveFileLinkReference(href, { workspaceRoot: cwd, baseDirectory });
  if (!link) return null;

  return {
    filePath: link.filePath,
    targetPath: link.targetPath,
    displayPath: formatWorkspaceRelativePath(link.targetPath, cwd),
    basename: basenameOfPath(link.filePath),
    ...(link.line !== undefined ? { line: link.line } : {}),
    ...(link.column !== undefined ? { column: link.column } : {}),
    workspacePath: link.workspacePath,
  };
}

/** Server-generated thread references resolve within the viewing environment. */
export function resolveMarkdownThreadHref(
  href: string | undefined,
  environmentId: string | undefined,
): string | null {
  if (!environmentId || !href?.startsWith("/ryco/thread/")) return null;
  const encodedId = href.slice("/ryco/thread/".length);
  try {
    const threadId = decodeURIComponent(encodedId);
    if (!threadId || threadId.length > 256 || threadId.includes("/") || threadId.includes("\\"))
      return null;
    for (const char of threadId) if (char.charCodeAt(0) < 32) return null;
    return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  } catch {
    return null;
  }
}
