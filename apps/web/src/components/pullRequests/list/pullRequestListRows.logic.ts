import type { ChangeRequest } from "@ryco/contracts";
import {
  deriveChangeRequestNextAction,
  summarizeChangeRequestChecks,
} from "@ryco/client-runtime/state/pull-request-review";

/**
 * What a list row says on its second line: the pull request's readiness as a
 * short state ("Check failing", "Ready to merge"), derived by the merge box's
 * next-action rules from the row's own fields.
 */
export type PullRequestReadinessTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "progress"
  | "merged";

export interface PullRequestReadiness {
  readonly label: string;
  readonly tone: PullRequestReadinessTone;
  /** Open and clear to merge on its own (for the stack spine's landable stretch). */
  readonly landable: boolean;
}

type ReadinessRow = Pick<
  ChangeRequest,
  "state" | "isDraft" | "mergeability" | "reviewDecision" | "checkRollup" | "baseRefName" | "author"
>;

function failingLabel(entry: ReadinessRow): string {
  const failing = summarizeChangeRequestChecks(entry.checkRollup).failing.length;
  return failing > 1 ? `${failing} checks failing` : "Check failing";
}

/**
 * Always derived from the row itself (never the selected pull request's
 * richer detail), so a label does not change just because the row was opened.
 */
export function describePullRequestReadiness(
  entry: ReadinessRow,
  options?: { readonly viewerLogin?: string | null | undefined },
): PullRequestReadiness {
  const action = deriveChangeRequestNextAction(entry);
  const own =
    options?.viewerLogin != null &&
    entry.author?.toLowerCase() === options.viewerLogin.toLowerCase();
  switch (action.kind) {
    case "merged":
      return { label: "Merged", tone: "merged", landable: false };
    case "closed":
      return { label: "Closed", tone: "neutral", landable: false };
    case "resolve-conflicts":
      return { label: "Conflicts", tone: "danger", landable: false };
    case "update-branch":
      return { label: "Behind base", tone: "warning", landable: false };
    case "mark-ready":
      return { label: own ? "Mark ready" : "Draft", tone: "neutral", landable: false };
    case "fix-checks":
      return {
        label: failingLabel(entry),
        tone: action.tone === "danger" ? "danger" : "warning",
        landable: false,
      };
    case "checks-running":
      return { label: "Checks running", tone: "progress", landable: false };
    case "changes-requested":
      return { label: "Changes requested", tone: "warning", landable: false };
    case "awaiting-review":
      return { label: "Awaiting review", tone: "neutral", landable: false };
    case "auto-merge-pending":
      return { label: "Merges when green", tone: "progress", landable: false };
    case "merge":
    case "merge-stack":
      return action.blocking
        ? { label: "Blocked", tone: "warning", landable: false }
        : { label: "Ready to merge", tone: "success", landable: true };
  }
}
