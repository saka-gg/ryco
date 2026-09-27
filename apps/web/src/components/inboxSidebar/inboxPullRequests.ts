import type { SourceControlChangeRequestDetail, VcsStatusResult } from "@ryco/contracts";
import { resolveThreadPr } from "../ThreadStatusIndicators";
import type { InboxSidebarRow } from "./inboxSidebarModel";

export type InboxPullRequest = NonNullable<InboxSidebarRow["pullRequest"]>;

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
  const selected = { ...current, state: detail.state, isDraft: detail.isDraft === true };
  const stack = detail.provider === "github" ? (detail.stack ?? null) : null;
  if (!stack) return { requests: [selected], stack: null };
  const requests: InboxPullRequest[] = stack.entries.map((entry) =>
    entry.number === current.number ? selected : entry,
  );
  // Partial metadata must never hide the thread's own PR.
  if (!requests.some((entry) => entry.number === current.number)) requests.push(selected);
  return { requests, stack };
}
