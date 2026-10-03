import type { ChangeRequest } from "@ryco/contracts";
import {
  deriveChangeRequestNextAction,
  summarizeChangeRequestChecks,
} from "@ryco/client-runtime/state/pull-request-review";
import type { ChangeRequestListReadiness } from "@ryco/shared/sourceControl";

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
  | "state"
  | "isDraft"
  | "mergeability"
  | "mergeStateStatus"
  | "reviewDecision"
  | "checkRollup"
  | "baseRefName"
  | "author"
>;

const OPEN: PullRequestReadiness = { label: "Open", tone: "neutral", landable: false };

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
  options?: {
    readonly viewerLogin?: string | null | undefined;
    /**
     * What the host's rows carry (`capabilities.listReadiness`, default
     * `verdict`). `none`: a row states only open, draft, merged or closed.
     * `blockers`: it also names the blockers it carries, and with none of
     * them reads "Open", never "Ready to merge" (what the row lacks, such as
     * reviews or branch policies, may still block it). Only `verdict` rows
     * can be landable.
     */
    readonly readiness?: ChangeRequestListReadiness | undefined;
  },
): PullRequestReadiness {
  const readiness = options?.readiness ?? "verdict";
  if (readiness === "none") {
    if (entry.state === "merged") return { label: "Merged", tone: "merged", landable: false };
    if (entry.state === "closed") return { label: "Closed", tone: "neutral", landable: false };
    return entry.isDraft === true ? { label: "Draft", tone: "neutral", landable: false } : OPEN;
  }
  const action = deriveChangeRequestNextAction(entry);
  // Every other step names a blocker the row itself states.
  if (
    readiness === "blockers" &&
    (action.kind === "merge" ||
      action.kind === "merge-stack" ||
      action.kind === "auto-merge-pending")
  ) {
    return OPEN;
  }
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
