import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

/** One checkout the pull requests page can read change requests through. */
export interface PullRequestRepositoryOption {
  /** Stable `${environmentId}\0${projectId}` key. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  /** Logical repository label (shared by every checkout of the same repository). */
  readonly name: string;
  readonly environmentLabel: string | null;
  /** Logical repository key; checkouts of one repository share it. */
  readonly repositoryKey: string;
  /** True for the representative checkout of its logical repository. */
  readonly isRepresentative: boolean;
}

export function pullRequestRepositoryKey(environmentId: string, projectId: string): string {
  return `${environmentId}\0${projectId}`;
}

/**
 * Flattens the sidebar's logical projects into selectable checkouts. The
 * representative checkout (primary environment first) leads its group so the
 * default choice reads through the local machine whenever it can.
 */
export function buildPullRequestRepositoryOptions(
  snapshots: readonly SidebarProjectSnapshot[],
): PullRequestRepositoryOption[] {
  const options: PullRequestRepositoryOption[] = [];
  for (const snapshot of snapshots) {
    const members = snapshot.memberProjects.toSorted((left, right) => {
      const leftRepresentative =
        left.environmentId === snapshot.environmentId && left.id === snapshot.id;
      const rightRepresentative =
        right.environmentId === snapshot.environmentId && right.id === snapshot.id;
      return Number(rightRepresentative) - Number(leftRepresentative);
    });
    for (const member of members) {
      options.push({
        key: pullRequestRepositoryKey(member.environmentId, member.id),
        environmentId: member.environmentId,
        projectId: member.id,
        cwd: member.cwd,
        name: snapshot.displayName,
        environmentLabel: member.environmentLabel,
        repositoryKey: snapshot.projectKey,
        isRepresentative:
          member.environmentId === snapshot.environmentId && member.id === snapshot.id,
      });
    }
  }
  return options;
}

/**
 * Whether an environment's projects can still arrive: "synced" (its live
 * snapshot is in, so what is listed is all there is), "syncing" (connecting,
 * or not yet started), "offline" (its connection dropped or failed), or
 * "unknown" (no such environment on this device).
 */
export type PullRequestEnvironmentSync = "synced" | "syncing" | "offline" | "unknown";

export function classifyPullRequestEnvironmentSync(input: {
  /** The environment's live shell snapshot has arrived. */
  readonly bootstrapComplete: boolean;
  readonly isPrimary: boolean;
  /** The saved (remote) environment's connection, when the id names one. */
  readonly saved: {
    readonly connectionState: SavedEnvironmentConnectionState;
    /** Set once a connection was made and lost; null before the first attempt. */
    readonly disconnectedAt: string | null;
  } | null;
  /** The id is in the saved-environment registry. */
  readonly savedKnown: boolean;
  /** The saved-environment registry has loaded, so an absent id is truly unknown. */
  readonly registryHydrated: boolean;
}): PullRequestEnvironmentSync {
  if (input.bootstrapComplete) return "synced";
  if (input.isPrimary) return "syncing";
  const saved = input.saved;
  if (saved) {
    if (saved.connectionState === "error") return "offline";
    if (saved.connectionState === "disconnected" && saved.disconnectedAt !== null) return "offline";
    return "syncing";
  }
  if (input.savedKnown) return "syncing";
  return input.registryHydrated ? "unknown" : "syncing";
}

export interface PullRequestRepositoryRequest {
  readonly env?: string | undefined;
  readonly project?: string | undefined;
}

/**
 * Which checkout the page reads. A repository named in the URL is honoured or
 * nothing is: while its environment syncs the page waits, and if it never
 * appears the page says so — it never quietly shows another repository (whose
 * `#N` would be a different pull request).
 */
export type PullRequestRepositoryResolution =
  | {
      readonly kind: "resolved";
      readonly option: PullRequestRepositoryOption;
      /** "url": named by the link; the rest are defaults when the URL names none. */
      readonly source: "url" | "last" | "recent" | "first";
    }
  | { readonly kind: "waiting"; readonly requested: PullRequestRepositoryRequest }
  | {
      readonly kind: "unavailable";
      readonly requested: PullRequestRepositoryRequest;
      readonly reason: "offline" | "missing";
    }
  /** No repositories at all (nothing added yet). */
  | { readonly kind: "empty" };

/**
 * Picks the checkout for the page: the one named in the URL (or, when it is
 * not listed, a waiting / unavailable state — never a substitute); with no
 * repository in the URL, the last one the user chose, else the checkout of the
 * most recently active thread (old worktree projects linger in the sidebar, so
 * recency beats sidebar order), else the first representative checkout.
 */
export function resolvePullRequestRepository(input: {
  readonly options: readonly PullRequestRepositoryOption[];
  readonly requested?: PullRequestRepositoryRequest | undefined;
  /** Sync state of the requested environment (the primary one when the URL names none). */
  readonly requestedEnvironmentSync?: PullRequestEnvironmentSync | undefined;
  readonly lastKey?: string | null | undefined;
  /** Option keys ordered by the latest thread activity in them, most recent first. */
  readonly recentKeys?: readonly string[] | undefined;
}): PullRequestRepositoryResolution {
  const { options, requested, lastKey, recentKeys } = input;
  if (requested?.project !== undefined) {
    const exact = options.find(
      (option) =>
        option.projectId === requested.project &&
        (requested.env === undefined || option.environmentId === requested.env),
    );
    if (exact) return { kind: "resolved", option: exact, source: "url" };
    switch (input.requestedEnvironmentSync ?? "synced") {
      case "syncing":
        return { kind: "waiting", requested };
      case "offline":
        return { kind: "unavailable", requested, reason: "offline" };
      case "synced":
      case "unknown":
        return { kind: "unavailable", requested, reason: "missing" };
    }
  }
  if (lastKey) {
    const last = options.find((option) => option.key === lastKey);
    if (last) return { kind: "resolved", option: last, source: "last" };
  }
  for (const key of recentKeys ?? []) {
    const recent = options.find((option) => option.key === key);
    if (recent) return { kind: "resolved", option: recent, source: "recent" };
  }
  const first = options.find((option) => option.isRepresentative) ?? options[0];
  return first ? { kind: "resolved", option: first, source: "first" } : { kind: "empty" };
}

/** The resolved checkout, or null while waiting / unavailable / empty. */
export function resolvedPullRequestRepository(
  resolution: PullRequestRepositoryResolution,
): PullRequestRepositoryOption | null {
  return resolution.kind === "resolved" ? resolution.option : null;
}

/**
 * The environment to name beside a checkout's repository, only when several
 * checkouts of that repository are on offer (otherwise the name says it all).
 */
export function pullRequestRepositoryQualifier(
  option: PullRequestRepositoryOption,
  options: readonly PullRequestRepositoryOption[],
): string | null {
  const shared = options.filter((candidate) => candidate.repositoryKey === option.repositoryKey);
  return shared.length > 1 && option.environmentLabel ? option.environmentLabel : null;
}

/** Option keys ordered by their threads' latest activity (most recent first). */
export function rankRepositoryKeysByThreadActivity(
  threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
    readonly updatedAt?: string | undefined;
    readonly latestUserMessageAt?: string | null | undefined;
  }>,
): string[] {
  const latest = new Map<string, number>();
  for (const thread of threads) {
    const at = Math.max(
      Date.parse(thread.latestUserMessageAt ?? "") || 0,
      Date.parse(thread.updatedAt ?? "") || 0,
    );
    if (at === 0) continue;
    const key = pullRequestRepositoryKey(thread.environmentId, thread.projectId);
    if (at > (latest.get(key) ?? 0)) latest.set(key, at);
  }
  return [...latest.entries()].toSorted((left, right) => right[1] - left[1]).map(([key]) => key);
}
