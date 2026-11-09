import type { VcsStatusResult } from "@ryco/contracts";

export interface SourceControlActionAvailability {
  readonly canCommit: boolean;
  readonly canPull: boolean;
  readonly canPush: boolean;
  readonly canCreatePullRequest: boolean;
}

export function sourceControlActionAvailability(
  status: VcsStatusResult | null,
  mutable: boolean,
): SourceControlActionAvailability {
  if (!status?.isRepo || !mutable) {
    return {
      canCommit: false,
      canPull: false,
      canPush: false,
      canCreatePullRequest: false,
    };
  }

  return {
    canCommit: status.hasWorkingTreeChanges,
    canPull: status.hasUpstream && status.behindCount > 0,
    canPush: status.hasPrimaryRemote && (status.hasWorkingTreeChanges || status.aheadCount > 0),
    canCreatePullRequest:
      status.hasPrimaryRemote &&
      status.pr === null &&
      !status.isDefaultRef &&
      status.refName !== null,
  };
}

export function sourceControlStatusLine(status: VcsStatusResult | null): string {
  if (!status) return "Loading repository status…";
  if (!status.isRepo) return "This workspace is not a Git repository.";

  const parts = [status.refName ?? "Detached HEAD"];
  if (status.aheadCount > 0) parts.push(`${status.aheadCount} ahead`);
  if (status.behindCount > 0) parts.push(`${status.behindCount} behind`);
  if (status.pr) parts.push(`PR #${status.pr.number} ${status.pr.state}`);
  return parts.join(" · ");
}

/** The status under the branch chip: sync state and PR, without repeating the branch. */
export function sourceControlSyncLine(status: VcsStatusResult | null): string {
  if (!status) return "Loading repository status…";
  if (!status.isRepo) return "This workspace is not a Git repository.";
  const parts: string[] = [];
  if (status.aheadCount > 0) parts.push(`${status.aheadCount} ahead`);
  if (status.behindCount > 0) parts.push(`${status.behindCount} behind`);
  if (status.pr) parts.push(`PR #${status.pr.number} ${status.pr.state}`);
  if (parts.length === 0) parts.push(status.hasUpstream ? "Up to date" : "Not pushed yet");
  return parts.join(" · ");
}
