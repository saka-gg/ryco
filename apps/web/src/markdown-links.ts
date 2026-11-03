import { resolveFileLinkReference } from "@ryco/client-runtime/state/files";
import type { EnvironmentId, ProjectId, ProjectKind } from "@ryco/contracts";
import {
  checkoutRepositoryKey,
  parseChangeRequestUrl,
  repositoryKeysMatch,
  type ChangeRequestUrlView,
} from "@ryco/shared/git";
import { isChatProject } from "@ryco/shared/projectKind";

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

/**
 * A plain primary click. Any modifier (a new tab, window or download) or
 * another button keeps the browser's own handling of a link.
 */
export function isPlainLinkClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export interface MarkdownChangeRequestCheckoutProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly kind?: ProjectKind | undefined;
  readonly repositoryIdentity?:
    | { readonly locator: { readonly remoteUrl: string } }
    | null
    | undefined;
}

export interface MarkdownChangeRequestCheckout {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly number: number;
  readonly tab?: ChangeRequestUrlView;
}

/**
 * The checkout a pull request link in chat opens through: a project whose
 * repository identity's remote matches the link's repository, on an
 * environment that can be read now. It matches only the identity's remote
 * (`upstream`, else `origin`, else the first by name), the one a number
 * resolves in, so a fork's checkout never opens upstream's `#N` as its own.
 * Order: the thread's own environment, then the primary one, then the order of
 * `projects` (pass the sidebar's, whose first checkout the Pull requests page
 * leads with). Null when the link is not one change request, points at one
 * comment (only the host scrolls to it), or no available project holds its
 * repository.
 */
export function resolveMarkdownChangeRequestCheckout(input: {
  readonly href: string | undefined;
  readonly projects: ReadonlyArray<MarkdownChangeRequestCheckoutProject>;
  readonly threadEnvironmentId: EnvironmentId | undefined;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** Connected (its live snapshot is in) and, when hosted, admitted for reads. */
  readonly isEnvironmentAvailable: (environmentId: EnvironmentId) => boolean;
}): MarkdownChangeRequestCheckout | null {
  if (!input.href) return null;
  const link = parseChangeRequestUrl(input.href);
  if (link === null || link.comment) return null;
  const availability = new Map<EnvironmentId, boolean>();
  const isAvailable = (environmentId: EnvironmentId) => {
    let available = availability.get(environmentId);
    if (available === undefined) {
      available = input.isEnvironmentAvailable(environmentId);
      availability.set(environmentId, available);
    }
    return available;
  };
  const matches = input.projects.filter((project) => {
    if (isChatProject(project)) return false;
    const key = checkoutRepositoryKey(project.repositoryIdentity?.locator.remoteUrl);
    return (
      key !== null &&
      repositoryKeysMatch(key, link.repositoryKey) &&
      isAvailable(project.environmentId)
    );
  });
  const project =
    matches.find((candidate) => candidate.environmentId === input.threadEnvironmentId) ??
    matches.find((candidate) => candidate.environmentId === input.primaryEnvironmentId) ??
    matches[0];
  if (project === undefined) return null;
  return {
    environmentId: project.environmentId,
    projectId: project.id,
    number: link.number,
    ...(link.view === undefined ? {} : { tab: link.view }),
  };
}
