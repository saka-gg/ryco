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
  const existingNames = new Set(existingBranchNames.map((refName) => refName.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
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

export function buildGeneratedWorktreeBranchName(
  raw: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): string {
  const normalized = raw
    .trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/['"`]/g, "");
  const existingPrefix = [prefix, LEGACY_WORKTREE_BRANCH_PREFIX].find(
    (candidate) =>
      candidate.length > 0 && normalized.toLowerCase().startsWith(`${candidate.toLowerCase()}/`),
  );
  const fragment =
    existingPrefix === undefined ? normalized : normalized.slice(existingPrefix.length + 1);
  return prefixWorktreeBranch(sanitizeBranchFragment(fragment), prefix);
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
