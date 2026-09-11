import type { EnvironmentId, RepositoryIdentity, VcsRef, ProjectId } from "@ryco/contracts";
import { Schema } from "effect";
import { isGenericLocalEnvironmentLabel, normalizeDisplayLabel } from "../environmentDisplay";

/**
 * Convert a git remote URL (scp-like `git@host:owner/repo.git`, `ssh://`,
 * `https://`, `git://`) into a browsable `https://host/owner/repo` URL.
 * Returns null when it can't be parsed.
 */
export function normalizeGitRemoteToWebUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!trimmed) return null;

  // Local filesystem remotes aren't browsable web URLs — bail so callers can
  // fall back to a hosted remote (e.g. Windows `C:/mirror/repo`, UNC `\\host`).
  if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith("\\\\")) {
    return null;
  }

  // scp-like syntax: [user@]host:owner/repo (no scheme, has a colon)
  if (!trimmed.includes("://")) {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (scp?.[1] && scp[2]) {
      return `https://${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
    }
    return null;
  }

  try {
    const parsed = new URL(
      trimmed.replace(/^(ssh|git|http):\/\//i, "https://").replace(/^ssh:/i, "https:"),
    );
    // Use `hostname` (not `host`) so an SSH port like `:2222` doesn't leak into
    // the derived https URL.
    if (!parsed.hostname || parsed.pathname === "/" || parsed.pathname === "") return null;
    return `https://${parsed.hostname}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Resolve a browsable repository URL from a project's repository identity. */
export function deriveRepositoryWebUrl(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  if (!identity) return null;
  const candidates = [
    identity.locator?.remoteUrl,
    ...(identity.remotes ?? []).map((remote) => remote.url),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const webUrl = normalizeGitRemoteToWebUrl(candidate);
    if (webUrl) return webUrl;
  }
  return null;
}
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@ryco/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
  isPrimary: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !isGenericLocalEnvironmentLabel(label);
    });
    return preferredLocalLabel ?? "Device connecting…";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: refName.worktreePath === activeProjectCwd ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
  /**
   * Extra text to match an item on when its value is a synthetic key rather
   * than the label — pull-request rows are keyed by number but should be
   * findable by title and head branch.
   */
  searchTextByItemValue?: ReadonlyMap<string, string> | undefined;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  const searchText = input.searchTextByItemValue?.get(itemValue);
  if (searchText !== undefined) {
    return searchText.toLowerCase().includes(normalizedQuery);
  }

  return itemValue.toLowerCase().includes(normalizedQuery);
}
