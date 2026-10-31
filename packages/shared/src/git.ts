import type {
  VcsRef,
  SourceControlProviderInfo,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@ryco/contracts";
import { DEFAULT_WORKTREE_BRANCH_PREFIX } from "@ryco/contracts/settings";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { detectSourceControlProviderFromRemoteUrl } from "./sourceControl.ts";

export const WORKTREE_BRANCH_PREFIX = DEFAULT_WORKTREE_BRANCH_PREFIX;
// Existing managed branches remain recognizable if the default changes.
const LEGACY_WORKTREE_BRANCH_PREFIX = "ryco";

/**
 * Sanitize an arbitrary string into a valid, lowercase git refName fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` refName name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` refName name that doesn't collide with
 * any existing refName. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  return resolveUniqueRefName(resolvedBase, existingBranchNames);
}

/**
 * `base` when no existing ref has that name (case-insensitively), otherwise
 * `base-N` with the smallest free `N` starting at `firstSuffix`.
 */
export function resolveUniqueRefName(
  base: string,
  existingRefNames: readonly string[],
  firstSuffix = 2,
): string {
  const existingNames = new Set(existingRefNames.map((refName) => refName.toLowerCase()));
  if (!existingNames.has(base.toLowerCase())) {
    return base;
  }
  let suffix = firstSuffix;
  while (existingNames.has(`${base}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/**
 * Strip the remote prefix from a remote ref such as `origin/feature/demo`.
 */
export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

/** Prefixes are validated by WorktreeBranchPrefix at the server settings boundary. */
export function prefixWorktreeBranch(fragment: string, prefix: string): string {
  return prefix.length > 0 ? `${prefix}/${fragment}` : fragment;
}

export function buildTemporaryWorktreeBranchName(prefix: string = WORKTREE_BRANCH_PREFIX): string {
  const token = Effect.runSync(Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, "0");
  return prefixWorktreeBranch(token, prefix);
}

/** Returns the original namespace, retaining legacy drafts after a settings change. */
export function extractTemporaryWorktreeBranchPrefix(
  refName: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): string | null {
  const ref = refName.trim();
  for (const candidate of [prefix, LEGACY_WORKTREE_BRANCH_PREFIX]) {
    const namespace = candidate.length > 0 ? `${candidate}/` : "";
    if (
      ref.toLowerCase().startsWith(namespace.toLowerCase()) &&
      /^[0-9a-f]{8}$/i.test(ref.slice(namespace.length))
    ) {
      return ref.slice(0, candidate.length);
    }
  }
  return null;
}

export function isTemporaryWorktreeBranch(
  refName: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): boolean {
  return extractTemporaryWorktreeBranchPrefix(refName, prefix) !== null;
}

/** An empty namespace cannot establish ownership of arbitrary named branches. */
export function isManagedWorktreeBranch(
  refName: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): boolean {
  const ref = refName.trim();
  return (
    [prefix, LEGACY_WORKTREE_BRANCH_PREFIX].some(
      (candidate) =>
        candidate.length > 0 &&
        ref.startsWith(`${candidate}/`) &&
        ref.length > candidate.length + 1,
    ) || isTemporaryWorktreeBranch(ref, prefix)
  );
}

/** The kinds of change a generated branch may start with, as in `fix/login-redirect`. */
export const WORKTREE_BRANCH_CHANGE_TYPES = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
] as const;

/**
 * With `changeTypes`, a name the model started with a known kind of change
 * (`fix/…`) replaces the prefix namespace; any other name stays under the prefix.
 */
export function buildGeneratedWorktreeBranchName(
  raw: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
  options?: { readonly changeTypes?: boolean | undefined },
): string {
  const normalized = raw
    .trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/['"`]/g, "");
  const existingPrefix = [prefix, LEGACY_WORKTREE_BRANCH_PREFIX].find(
    (candidate) =>
      candidate.length > 0 && normalized.toLowerCase().startsWith(`${candidate.toLowerCase()}/`),
  );
  const fragment = sanitizeBranchFragment(
    existingPrefix === undefined ? normalized : normalized.slice(existingPrefix.length + 1),
  );
  if (options?.changeTypes === true) {
    const [changeType = "", ...rest] = fragment.split("/");
    const description = rest.join("-");
    if (
      /[a-z0-9]/.test(description) &&
      (WORKTREE_BRANCH_CHANGE_TYPES as ReadonlyArray<string>).includes(changeType)
    ) {
      return `${changeType}/${sanitizeBranchFragment(description)}`;
    }
  }
  return prefixWorktreeBranch(fragment, prefix);
}

/**
 * Normalize a git remote URL into a stable comparison key.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositoryPath = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .join("/");
      if (url.hostname && repositoryPath.includes("/")) {
        return `${url.hostname}/${repositoryPath}`;
      }
    } catch {
      return normalized;
    }
  }

  const scpStyleHostAndPath = /^git@([^:/\s]+)[:/]([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scpStyleHostAndPath?.[1] && scpStyleHostAndPath[2]) {
    return `${scpStyleHostAndPath[1]}/${scpStyleHostAndPath[2]}`;
  }

  return normalized;
}

/**
 * Best-effort parse of a GitHub `owner/repo` identifier from common remote URL shapes.
 */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

/**
 * Hide `origin/*` remote refs when a matching local refName already exists.
 */
export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    refs.filter((refName) => !refName.isRemote).map((refName) => refName.name),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function detectSourceControlProviderFromGitRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  return detectSourceControlProviderFromRemoteUrl(remoteUrl);
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    ...(status.upstreamRef === undefined ? {} : { upstreamRef: status.upstreamRef }),
    ...(status.headCommit === undefined ? {} : { headCommit: status.headCommit }),
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
    ...(status.committed ? { committed: status.committed } : {}),
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}

// ── Change request URLs ──────────────────────────────────────────────

function decodeUrlSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Azure DevOps names one repository several ways (dev.azure.com/{org} or
 * {org}.visualstudio.com, with or without the project or a DefaultCollection
 * segment): key it by organisation, project and repository, the project
 * defaulting to the repository as Azure does.
 */
function azureRepositoryKey(
  organization: string,
  beforeRepository: ReadonlyArray<string>,
  repository: string,
): string {
  const project =
    beforeRepository.findLast((segment) => segment.toLowerCase() !== "defaultcollection") ??
    repository;
  return `azure:${organization}/${project}/${repository}`.toLowerCase();
}

function azureOrganization(host: string, segments: ReadonlyArray<string>): string | undefined {
  if (host === "dev.azure.com") return segments[0];
  if (host.endsWith(".visualstudio.com")) return host.slice(0, -".visualstudio.com".length);
  return undefined;
}

/** The path segment a change request adds to its repository's web URL, on every host Ryco reads. */
const CHANGE_REQUEST_PATH =
  /^(.*?)\/(?:-\/)?(?:pull|pulls|pull-requests|pullrequest|pullrequests|merge_requests)\/(\d+)(?:\/(.*))?$/iu;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/** `changeRequestRepositoryKey` of a parsed URL; `match` is `CHANGE_REQUEST_PATH` on its path. */
function urlChangeRequestRepositoryKey(url: URL, match: RegExpExecArray | null): string | null {
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map(decodeUrlSegment);
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  const organization = azureOrganization(hostname, segments);
  if (organization !== undefined && gitIndex !== -1) {
    const repository = segments[gitIndex + 1];
    if (!repository || !/^pullrequest$/iu.test(segments[gitIndex + 2] ?? "")) return null;
    return azureRepositoryKey(
      organization,
      segments.slice(hostname === "dev.azure.com" ? 1 : 0, gitIndex),
      repository,
    );
  }
  return match?.[1] ? `${url.host}${decodeUrlSegment(match[1])}`.toLowerCase() : null;
}

/**
 * The repository a change request URL lives in: host and path before its
 * pull/merge request segment (any case) on GitHub, GitLab, Forgejo and
 * Bitbucket, `azure:{org}/{project}/{repo}` on Azure DevOps; null when the
 * URL does not name a change request. A pasted link to another repository's
 * pull request can be refused with it before it is linked to a workspace.
 */
export function changeRequestRepositoryKey(value: string): string | null {
  const url = parseUrl(value);
  return url && urlChangeRequestRepositoryKey(url, CHANGE_REQUEST_PATH.exec(url.pathname));
}

/** `user@host:path` (scp-like SSH) as an `ssh://` URL, so one parser reads every remote. */
function remoteAsUrl(remoteUrl: string): URL | null {
  const scp = /^(?:([^@\s/:]+)@)?([^@\s/:]+):(?!\/\/)(.+)$/u.exec(remoteUrl);
  return parseUrl(scp ? `ssh://${scp[1] ? `${scp[1]}@` : ""}${scp[2]}/${scp[3]}` : remoteUrl);
}

/**
 * The Azure DevOps repository a checkout's remote points at, in the
 * `changeRequestRepositoryKey` form; null for other hosts or unknown shapes.
 * Reads HTTPS (`[user@]dev.azure.com/{org}/{project}/_git/{repo}`,
 * `{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`), SSH v3
 * (`ssh.dev.azure.com` / `vs-ssh.visualstudio.com`, scp-like or `ssh://` with
 * a port) and the legacy `_ssh` paths. Azure pull request ids are
 * organisation-wide, so this is the only way to tell the workspace's
 * repository from a sibling's.
 */
export function azureRemoteRepositoryKey(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const url = remoteAsUrl(remoteUrl.trim());
  if (url === null) return null;
  // The hostname, not the host: an SSH remote may carry a port.
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeUrlSegment(segment).replace(/\.git$/iu, ""));
  const sshHost = hostname === "ssh.dev.azure.com" || hostname === "vs-ssh.visualstudio.com";
  if (sshHost && segments[0]?.toLowerCase() === "v3") {
    const [, organization, project, repository] = segments;
    return organization && project && repository
      ? azureRepositoryKey(organization, [project], repository)
      : null;
  }
  const repoIndex = segments.findIndex((segment) => /^_(?:git|ssh)$/iu.test(segment));
  const repository = segments[repoIndex + 1];
  if (repoIndex === -1 || !repository) return null;
  const organizationInPath = hostname === "dev.azure.com" || hostname === "ssh.dev.azure.com";
  const organization = organizationInPath
    ? segments[0]
    : hostname === "vs-ssh.visualstudio.com"
      ? decodeUrlSegment(url.username) || undefined
      : hostname.endsWith(".visualstudio.com")
        ? hostname.slice(0, -".visualstudio.com".length)
        : undefined;
  if (!organization) return null;
  return azureRepositoryKey(
    organization,
    segments.slice(organizationInPath ? 1 : 0, repoIndex),
    repository,
  );
}

/**
 * The repository a checkout's remote names, in the `changeRequestRepositoryKey`
 * form, so it compares with a change request URL's key (`repositoryKeysMatch`);
 * null for an empty remote. An scp-like remote reads as host and path whatever
 * its SSH user (`gitea@host:o/r`, or none), not only `git@`.
 */
export function checkoutRepositoryKey(remoteUrl: string | null | undefined): string | null {
  const trimmed = remoteUrl?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return (
    azureRemoteRepositoryKey(trimmed) ??
    normalizeGitRemoteUrl(remoteAsUrl(trimmed)?.toString() ?? trimmed)
  );
}

/**
 * A repository key without a `:port` on its host, lowercased: web URLs may carry one,
 * remotes rarely do. Keys that name the same repository (`repositoryKeysMatch`) are equal here.
 */
export function repositoryKeyWithoutPort(key: string): string {
  const lower = key.toLowerCase();
  if (lower.startsWith("azure:")) return lower;
  const slash = lower.indexOf("/");
  if (slash === -1) return lower.replace(/:\d+$/u, "");
  return `${lower.slice(0, slash).replace(/:\d+$/u, "")}${lower.slice(slash)}`;
}

/** Whether two repository keys name the same repository (a port on the host is ignored). */
export function repositoryKeysMatch(left: string, right: string): boolean {
  return repositoryKeyWithoutPort(left) === repositoryKeyWithoutPort(right);
}

/** The part of a change request a URL opens, when it is not the conversation. */
export type ChangeRequestUrlView = "files" | "checks" | "commits";

export interface ChangeRequestUrl {
  readonly number: number;
  /** The web URL before the pull/merge request segment (`https://github.com/acme/app`). */
  readonly repositoryUrl: string;
  /** `changeRequestRepositoryKey` of the URL. */
  readonly repositoryKey: string;
  /** The URL opens the change request's files, checks or commits; absent for the conversation. */
  readonly view?: ChangeRequestUrlView;
  /** The URL points at one comment or review, which only the host can scroll to. */
  readonly comment?: true;
}

// A Map, not an object literal: the keys come from untrusted URL text, which
// must not reach inherited names such as `constructor`.
const CHANGE_REQUEST_URL_VIEWS: ReadonlyMap<string, ChangeRequestUrlView> = new Map([
  ["files", "files"],
  // GitHub's newer Files changed page.
  ["changes", "files"],
  ["diffs", "files"],
  ["diff", "files"],
  ["checks", "checks"],
  ["pipelines", "checks"],
  ["commits", "commits"],
]);

/** GitHub (`#r…` on the Files page), GitLab, Forgejo and Bitbucket comment anchors. */
const CHANGE_REQUEST_COMMENT_ANCHOR =
  /^#(?:issuecomment-|discussion_r|pullrequestreview-|note_|comment-|r\d)/iu;

/**
 * An http(s) link to one change request on GitHub (`/pull/N`), GitLab
 * (`/-/merge_requests/N`), Forgejo/Gitea (`/pulls/N`), Bitbucket
 * (`/pull-requests/N`) or Azure DevOps (`/_git/<repo>/pullrequest/N`), with
 * any trailing path, query or hash; null otherwise (issues, commits,
 * repository pages, non-http schemes).
 */
export function parseChangeRequestUrl(value: string): ChangeRequestUrl | null {
  const url = parseUrl(value);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const match = CHANGE_REQUEST_PATH.exec(url.pathname);
  if (!match?.[1] || !match[2]) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const repositoryKey = urlChangeRequestRepositoryKey(url, match);
  if (repositoryKey === null) return null;
  const tail = match[3]?.split("/")[0]?.toLowerCase();
  // Azure DevOps names the tab in the query (`?_a=files`).
  const view =
    CHANGE_REQUEST_URL_VIEWS.get(tail ?? "") ??
    CHANGE_REQUEST_URL_VIEWS.get(url.searchParams.get("_a")?.toLowerCase() ?? "");
  // Azure DevOps and Bitbucket Data Center name the comment in the query.
  const comment =
    CHANGE_REQUEST_COMMENT_ANCHOR.test(url.hash) ||
    url.searchParams.has("discussionId") ||
    url.searchParams.has("commentId");
  return {
    number,
    repositoryUrl: `${url.origin}${match[1]}`,
    repositoryKey,
    ...(view === undefined ? {} : { view }),
    ...(comment ? { comment: true as const } : {}),
  };
}

/** The change request number a URL names (the segment after pull/merge request); null otherwise. */
export function changeRequestNumberFromUrl(value: string): number | null {
  return parseChangeRequestUrl(value)?.number ?? null;
}
