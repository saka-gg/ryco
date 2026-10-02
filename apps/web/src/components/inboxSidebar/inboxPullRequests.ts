import type { SourceControlChangeRequestDetail, VcsStatusResult } from "@ryco/contracts";
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
