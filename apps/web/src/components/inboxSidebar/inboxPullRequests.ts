import type { SourceControlChangeRequestDetail, VcsStatusResult } from "@ryco/contracts";
import { type CheckRollupSummary, summarizeCheckRollup } from "../projectExplorer/prCheckStatus";
import { resolveThreadPr } from "../ThreadStatusIndicators";
import type { InboxSidebarRow } from "./inboxSidebarModel";

/** Title and link arrive with live source control; projected rows carry only number and state. */
export type InboxPullRequest = NonNullable<InboxSidebarRow["pullRequest"]> & {
  readonly title?: string | undefined;
  readonly url?: string | undefined;
};

export function resolveInboxPullRequest(
  row: Pick<InboxSidebarRow, "branchLabel" | "pullRequest">,
  status: VcsStatusResult | null,
): InboxPullRequest | null {
  const live = resolveThreadPr(row.branchLabel, status);
  if (!live) return row.pullRequest;
  return {
    number: live.number,
    state: live.state,
    isDraft: row.pullRequest?.number === live.number && row.pullRequest.isDraft,
    title: live.title,
    url: live.url || undefined,
  };
}

export function resolveInboxPullRequests(
  current: InboxPullRequest | null,
  detail: SourceControlChangeRequestDetail | null,
) {
  if (!current) return { requests: [], stack: null };
  if (!detail || detail.number !== current.number) {
    return { requests: [current], stack: null };
  }
  const selected: InboxPullRequest = {
    ...current,
    state: detail.state,
    isDraft: detail.isDraft === true,
    title: detail.title,
    url: detail.url,
  };
  const stack = detail.provider === "github" ? (detail.stack ?? null) : null;
  if (!stack) return { requests: [selected], stack: null };
  const requests: InboxPullRequest[] = stack.entries.map((entry) =>
    entry.number === current.number ? selected : entry,
  );
  // Partial metadata must never hide the thread's own PR.
  if (!requests.some((entry) => entry.number === current.number)) requests.push(selected);
  return { requests, stack };
}

/**
 * What changed, for the hover card: the pull request's checks and diff when
 * its detail is loaded, otherwise the uncommitted working tree of the
 * thread's checked-out branch.
 */
export interface InboxChangeStats {
  readonly scope: "pull-request" | "working-tree";
  readonly checks: CheckRollupSummary | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
}

export function resolveInboxChangeStats(input: {
  readonly current: InboxPullRequest | null;
  readonly detail: SourceControlChangeRequestDetail | null;
  readonly status: VcsStatusResult | null;
  readonly branchLabel: string | null;
}): InboxChangeStats | null {
  const { current, detail, status } = input;
  if (current && detail && detail.number === current.number) {
    const checks = summarizeCheckRollup(detail);
    const additions = detail.additions ?? null;
    const deletions = detail.deletions ?? null;
    if (!checks && additions === null && deletions === null) return null;
    return {
      scope: "pull-request",
      checks,
      additions,
      deletions,
      changedFiles: detail.changedFiles ?? null,
    };
  }
  // Working-tree numbers describe whatever is checked out; only trust them
  // for the thread whose branch that is.
  if (!status || status.refName !== input.branchLabel || !status.hasWorkingTreeChanges) {
    return null;
  }
  return {
    scope: "working-tree",
    checks: null,
    additions: status.workingTree.insertions,
    deletions: status.workingTree.deletions,
    changedFiles: status.workingTree.files.length,
  };
}
