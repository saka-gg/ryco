import type { SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";

// Pure derivation of the small badge a worktree carries in the inbox row and in
// the thread context bar: its pull request, its Jira work item, or its issue.
//
// HONESTY: none of this is live. `prState` has no background refresher — the
// server updates it on worktree operations or as a tap on a `sourceControl`
// RPC, and mobile issues none of those. So every badge here is LAST KNOWN
// state, which is why it renders as outlined metadata rather than a filled
// status chip, and why the accessibility label says so out loud. Do not restyle
// it to look live without first giving it something that actually refreshes.

export type ChangeRequestTone = "open" | "draft" | "merged" | "closed" | "neutral";

export interface ChangeRequestBadge {
  readonly kind: "pull-request" | "issue" | "work-item";
  /** Short form for the row: `#42`, or a Jira key like `RYC-8`. */
  readonly label: string;
  readonly tone: ChangeRequestTone;
  readonly accessibilityLabel: string;
}

type WorktreeBadgeSource = Pick<
  SidebarWorktreeSummary,
  | "prNumber"
  | "prState"
  | "prIsDraft"
  | "issueNumber"
  | "issueState"
  | "workItemKey"
  | "workItemState"
  | "workItemStateName"
>;

const LAST_KNOWN = "Last known state.";

function pullRequestTone(
  state: SidebarWorktreeSummary["prState"],
  isDraft: SidebarWorktreeSummary["prIsDraft"],
): ChangeRequestTone {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  // Draft only means anything while the PR is still open — a merged draft is
  // not a thing, and a closed one is just closed.
  if (state === "open") return isDraft ? "draft" : "open";
  return "neutral";
}

function pullRequestStateWord(
  state: SidebarWorktreeSummary["prState"],
  isDraft: SidebarWorktreeSummary["prIsDraft"],
): string {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  if (state === "open") return isDraft ? "open, draft" : "open";
  return "state unknown";
}

function workItemTone(state: SidebarWorktreeSummary["workItemState"]): ChangeRequestTone {
  switch (state) {
    case "done":
      return "merged";
    case "closed":
      return "closed";
    case "in_progress":
      return "open";
    case "open":
      return "open";
    default:
      return "neutral";
  }
}

/**
 * At most one badge: an inbox row has room for a number, not a status board.
 * A pull request is the strongest signal of where the work stands, then the
 * tracked work item, then a bare issue.
 *
 * The wording is deliberately "Pull request" even on GitLab/Bitbucket.
 * `resolveChangeRequestPresentation` in @ryco/shared would say "merge request"
 * instead, but it needs a `SourceControlProviderInfo` and mobile has never
 * subscribed to the VCS status stream that carries one. Rather than guess the
 * provider, this says the common thing and stays wrong only in wording.
 */
export function buildChangeRequestBadge(
  worktree: WorktreeBadgeSource | null | undefined,
): ChangeRequestBadge | null {
  if (!worktree) return null;

  if (worktree.prNumber !== null) {
    const tone = pullRequestTone(worktree.prState, worktree.prIsDraft);
    return {
      kind: "pull-request",
      label: `#${worktree.prNumber}`,
      tone,
      accessibilityLabel: `Pull request ${worktree.prNumber}, ${pullRequestStateWord(
        worktree.prState,
        worktree.prIsDraft,
      )}. ${LAST_KNOWN}`,
    };
  }

  if (worktree.workItemKey) {
    const stateWord =
      worktree.workItemStateName?.trim() || worktree.workItemState || "state unknown";
    return {
      kind: "work-item",
      label: worktree.workItemKey,
      tone: workItemTone(worktree.workItemState),
      accessibilityLabel: `Work item ${worktree.workItemKey}, ${stateWord}. ${LAST_KNOWN}`,
    };
  }

  if (worktree.issueNumber !== null) {
    return {
      kind: "issue",
      label: `#${worktree.issueNumber}`,
      tone:
        worktree.issueState === "closed"
          ? "closed"
          : worktree.issueState === "open"
            ? "open"
            : "neutral",
      accessibilityLabel: `Issue ${worktree.issueNumber}, ${
        worktree.issueState ?? "state unknown"
      }. ${LAST_KNOWN}`,
    };
  }

  return null;
}
