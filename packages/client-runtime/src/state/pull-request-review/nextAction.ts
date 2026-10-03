import type {
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
  SourceControlChangeRequestStack,
  SourceControlChangeRequestStackEntry,
} from "@ryco/contracts";

import { summarizeChangeRequestChecks, type ChangeRequestChecksSummary } from "./checks.ts";

export type ChangeRequestNextActionKind =
  | "merged"
  | "closed"
  | "resolve-conflicts"
  | "update-branch"
  | "mark-ready"
  | "fix-checks"
  | "checks-running"
  | "changes-requested"
  | "awaiting-review"
  | "auto-merge-pending"
  | "merge"
  | "merge-stack";

export type ChangeRequestNextActionTone = "neutral" | "success" | "warning" | "danger" | "progress";

/**
 * The single next step for the merge control. The control always renders it:
 * `blocking` means merging is not possible right now, so the merge button is
 * disabled (or replaced by the unblocking action) and `reason` says why.
 * Non-blocking states may still carry a `reason` (e.g. merging past failing
 * non-required checks).
 */
export interface ChangeRequestNextAction {
  readonly kind: ChangeRequestNextActionKind;
  readonly label: string;
  readonly reason?: string;
  readonly tone: ChangeRequestNextActionTone;
  readonly blocking: boolean;
  /** True when the viewer can perform the unblocking step (or the merge) themselves. */
  readonly viewerCanAct: boolean;
}

export type ChangeRequestNextActionDetail = Pick<
  SourceControlChangeRequestDetail,
  | "state"
  | "isDraft"
  | "mergeability"
  | "mergeStateStatus"
  | "reviewDecision"
  | "reviewerStates"
  | "reviewers"
  | "checkRollup"
  | "autoMerge"
  | "stack"
  | "stackMetadataIncomplete"
  | "mergeCapabilities"
  | "baseRefName"
  | "mergedBy"
>;

export interface ChangeRequestNextActionActivity {
  readonly viewer: ChangeRequestViewerCapabilities | null;
}

const MERGE_METHOD_LABELS: Record<SourceControlChangeRequestMergeMethod, string> = {
  merge: "a merge commit",
  squash: "squash",
  rebase: "rebase",
};

function listLogins(logins: ReadonlyArray<string>, limit = 3): string {
  const shown = logins.slice(0, limit).map((login) => `@${login}`);
  const rest = logins.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
}

/** The facts the merge itself (one pull request, or the stack through it) depends on. */
export type ChangeRequestMergeActionDetail = Pick<
  ChangeRequestNextActionDetail,
  | "stack"
  | "stackMetadataIncomplete"
  | "mergeCapabilities"
  | "mergeStateStatus"
  | "mergeability"
  | "baseRefName"
>;

/** The host lets this merge through right now (non-required checks may still fail). */
function hostAllowsMerge(detail: Pick<ChangeRequestNextActionDetail, "mergeStateStatus">): boolean {
  return (
    detail.mergeStateStatus === "clean" ||
    detail.mergeStateStatus === "unstable" ||
    detail.mergeStateStatus === "has_hooks"
  );
}

/** Layers below this one that a stack merge would land together with it. */
function pendingLowerLayers(
  stack: SourceControlChangeRequestStack,
): ReadonlyArray<SourceControlChangeRequestStackEntry> {
  return stack.entries.filter(
    (entry) => entry.position < stack.position && entry.state !== "merged",
  );
}

function stackLayerBlocker(
  entries: ReadonlyArray<SourceControlChangeRequestStackEntry>,
): string | null {
  for (const entry of entries) {
    if (entry.state === "closed") return `#${entry.number} below is closed without being merged.`;
    if (entry.isDraft) return `#${entry.number} below is still a draft.`;
    const status = entry.mergeStateStatus?.trim().toLowerCase() ?? "";
    if (entry.mergeability === "conflicting" || status === "dirty") {
      return `#${entry.number} below has merge conflicts.`;
    }
    if (status === "blocked") return `#${entry.number} below is blocked from merging.`;
  }
  return null;
}

/**
 * Derives the one action the merge control should offer, ranked by what
 * unblocks the merge next: terminal state, conflicts, draft, a stale base,
 * failing checks, requested changes, an armed auto-merge, running checks,
 * missing reviews, and finally the merge itself (through the stack when lower
 * layers are still open).
 */
export function deriveChangeRequestNextAction(
  detail: ChangeRequestNextActionDetail,
  activity?: ChangeRequestNextActionActivity | null,
  checksSummary?: ChangeRequestChecksSummary | null,
): ChangeRequestNextAction {
  const viewer = activity?.viewer ?? null;
  const checks = checksSummary ?? summarizeChangeRequestChecks(detail.checkRollup);
  const canUpdate = viewer?.canUpdate ?? true;
  const canMerge = viewer?.canMerge ?? true;
  const allowsMerge = hostAllowsMerge(detail);

  if (detail.state === "merged") {
    return {
      kind: "merged",
      label: "Merged",
      ...(detail.mergedBy ? { reason: `Merged by @${detail.mergedBy}.` } : {}),
      tone: "success",
      blocking: true,
      viewerCanAct: false,
    };
  }
  if (detail.state === "closed") {
    return {
      kind: "closed",
      label: "Closed",
      reason: "Reopen this pull request to merge it.",
      tone: "neutral",
      blocking: true,
      viewerCanAct: canUpdate,
    };
  }

  if (detail.mergeability === "conflicting" || detail.mergeStateStatus === "dirty") {
    return {
      kind: "resolve-conflicts",
      label: "Resolve conflicts",
      reason: `This branch has conflicts with ${detail.baseRefName} that must be resolved.`,
      tone: "danger",
      blocking: true,
      viewerCanAct: canUpdate,
    };
  }

  if (detail.isDraft === true || detail.mergeStateStatus === "draft") {
    return {
      kind: "mark-ready",
      label: "Mark ready for review",
      reason: canUpdate
        ? "Drafts cannot be merged."
        : "Drafts cannot be merged. The author has to mark it ready for review.",
      tone: "neutral",
      blocking: true,
      viewerCanAct: canUpdate,
    };
  }

  if (detail.mergeStateStatus === "behind") {
    const canUpdateBranch = viewer?.canUpdateBranch ?? true;
    return {
      kind: "update-branch",
      label: "Update branch",
      reason: `This branch is out of date with ${detail.baseRefName}.`,
      tone: "warning",
      blocking: true,
      viewerCanAct: canUpdateBranch,
    };
  }

  if (checks.overall === "failing") {
    const names = checks.failing.slice(0, 3).map((check) => check.label);
    const more = checks.failing.length - names.length;
    const failingText = `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    return {
      kind: "fix-checks",
      label: "Fix failing checks",
      reason: allowsMerge
        ? `${failingText} failed, but no required check is failing.`
        : `${failingText} ${checks.failing.length === 1 ? "is" : "are"} failing.`,
      tone: allowsMerge ? "warning" : "danger",
      blocking: !allowsMerge,
      viewerCanAct: canUpdate,
    };
  }

  if (detail.reviewDecision === "changes_requested") {
    const requesters = (detail.reviewerStates ?? [])
      .filter((reviewer) => reviewer.state === "changes_requested")
      .map((reviewer) => reviewer.login);
    return {
      kind: "changes-requested",
      label: "Changes requested",
      reason:
        requesters.length > 0
          ? `${listLogins(requesters)} requested changes.`
          : "A reviewer requested changes.",
      tone: "warning",
      blocking: !allowsMerge,
      viewerCanAct: canUpdate,
    };
  }

  if (detail.autoMerge) {
    const waitingOn =
      checks.overall === "pending"
        ? "checks pass"
        : detail.reviewDecision === "review_required"
          ? "it is approved"
          : "all requirements are met";
    return {
      kind: "auto-merge-pending",
      label: "Auto-merge enabled",
      reason: `Merges with ${MERGE_METHOD_LABELS[detail.autoMerge.mergeMethod]} once ${waitingOn}.`,
      tone: "progress",
      blocking: true,
      viewerCanAct: viewer?.canDisableAutoMerge ?? canMerge,
    };
  }

  if (checks.overall === "pending") {
    return {
      kind: "checks-running",
      label: "Checks running",
      reason: `${checks.description}.`,
      tone: "progress",
      blocking: !allowsMerge,
      // Mergeable now, or the viewer can arm auto-merge to land it when checks pass.
      viewerCanAct: allowsMerge ? canMerge : (viewer?.canEnableAutoMerge ?? false),
    };
  }

  if (detail.reviewDecision === "review_required") {
    const requested = (detail.reviewerStates ?? [])
      .filter((reviewer) => reviewer.state === "requested")
      .map((reviewer) => reviewer.login);
    const pending = requested.length > 0 ? requested : (detail.reviewers ?? []);
    return {
      kind: "awaiting-review",
      label: "Awaiting review",
      reason:
        pending.length > 0
          ? `Waiting on ${listLogins(pending)}.`
          : "An approving review is required before merging.",
      tone: "neutral",
      blocking: !allowsMerge,
      viewerCanAct: (viewer?.canReview ?? false) && viewer?.isAuthor !== true,
    };
  }

  return deriveMergeAction(detail, viewer, allowsMerge);
}

/**
 * The merge itself, as the merge control offers it once nothing ranks ahead
 * of it: `merge`, or `merge-stack` when open layers below would land with it,
 * blocked by permissions, disabled methods, incomplete stack metadata, a lower
 * layer that cannot land, or branch protection. A next action that does not
 * block the merge (failing optional checks, running checks or reviews the host
 * does not require) still merges this way, so callers offering that merge use
 * this rather than assuming a single pull request.
 */
export function deriveChangeRequestMergeAction(
  detail: ChangeRequestMergeActionDetail,
  activity?: ChangeRequestNextActionActivity | null,
): ChangeRequestNextAction {
  return deriveMergeAction(detail, activity?.viewer ?? null, hostAllowsMerge(detail));
}

function deriveMergeAction(
  detail: ChangeRequestMergeActionDetail,
  viewer: ChangeRequestViewerCapabilities | null,
  allowsMerge: boolean,
): ChangeRequestNextAction {
  const lowerLayers = detail.stack ? pendingLowerLayers(detail.stack) : [];
  const isStackMerge = lowerLayers.length > 0;
  const kind: ChangeRequestNextActionKind = isStackMerge ? "merge-stack" : "merge";
  const label = isStackMerge
    ? `Merge ${lowerLayers.length + 1} pull requests`
    : "Merge pull request";
  const blocked = (
    reason: string,
    tone: ChangeRequestNextActionTone = "warning",
  ): ChangeRequestNextAction => ({
    kind,
    label,
    reason,
    tone,
    blocking: true,
    viewerCanAct: false,
  });

  if (viewer !== null && !viewer.canMerge) {
    return blocked("You do not have permission to merge this pull request.", "neutral");
  }
  if (
    detail.mergeCapabilities &&
    !detail.mergeCapabilities.merge &&
    !detail.mergeCapabilities.squash &&
    !detail.mergeCapabilities.rebase
  ) {
    return blocked("No merge method is enabled for this repository.");
  }
  if (detail.stackMetadataIncomplete === true) {
    return blocked("Stack details are temporarily unavailable. Refresh before merging.");
  }
  const stackBlocker = stackLayerBlocker(lowerLayers);
  if (stackBlocker !== null) return blocked(stackBlocker, "danger");
  if (detail.mergeStateStatus === "blocked") {
    return blocked("Branch protection rules are blocking this merge.");
  }

  const unsettled =
    detail.mergeability === "unknown" ||
    detail.mergeStateStatus === "unknown" ||
    (detail.mergeStateStatus === undefined && detail.mergeability === undefined);
  return {
    kind,
    label,
    ...(isStackMerge
      ? {
          reason: `Merges #${lowerLayers.map((entry) => entry.number).join(", #")} and this pull request into ${detail.stack?.baseRefName ?? detail.baseRefName}.`,
        }
      : unsettled && !allowsMerge
        ? { reason: "The host is still checking whether this can merge cleanly." }
        : {}),
    tone: unsettled && !allowsMerge ? "progress" : "success",
    blocking: false,
    viewerCanAct: true,
  };
}
