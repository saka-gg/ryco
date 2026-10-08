import type { OverviewLayoutProps, OverviewPanelItem } from "./overviewTypes";

/**
 * Pure overview metrics shared by the classic panel and the Crown rail.
 * Kept free of React so `.logic.ts` consumers and unit tests stay cheap.
 */

export interface OverviewSummary {
  additions: number;
  deletions: number;
  hasDiff: boolean;
  fileCount: number;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checksRunning: number;
  planTotal: number;
  planDone: number;
  agentsTotal: number;
  agentsRunning: number;
  refName: string | null;
  aheadCount: number;
  behindCount: number;
}

/** Compute aggregated metrics (diff, checks, plan progress, agent status) from layout props for rendering badges and summaries. */
export function getOverviewSummary(props: OverviewLayoutProps): OverviewSummary {
  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  let hasDiff = false;
  if (props.changes) {
    additions = props.changes.insertions;
    deletions = props.changes.deletions;
    fileCount = props.changes.files.length;
    hasDiff = fileCount > 0 || additions > 0 || deletions > 0;
  } else {
    for (const item of props.overviewItems ?? []) {
      if (typeof item.additions === "number") {
        additions += item.additions;
        hasDiff = true;
      }
      if (typeof item.deletions === "number") {
        deletions += item.deletions;
        hasDiff = true;
      }
    }
  }
  const runs = props.pullRequest?.latestRuns ?? [];
  let checksPassed = 0;
  let checksFailed = 0;
  let checksRunning = 0;
  for (const run of runs) {
    if (run.tone === "success") checksPassed += 1;
    else if (run.tone === "failure" || run.tone === "error") checksFailed += 1;
    else if (run.tone === "running") checksRunning += 1;
  }
  const steps = props.activePlan?.steps ?? [];
  const agents = props.subagents ?? [];
  // Progress numerator counts steps that have been *reached* — completed plus the
  // currently in-progress step — to mirror the lab's "N of M" / percentage (e.g.
  // 2 done + 1 active of 5 = 3/5 = 60%). The per-step markers still key off the
  // raw status, so only completed steps render a check.
  const planReached = steps.filter(
    (step) => step.status === "completed" || step.status === "inProgress",
  ).length;
  return {
    additions,
    deletions,
    hasDiff,
    fileCount,
    checksTotal: runs.length,
    checksPassed,
    checksFailed,
    checksRunning,
    planTotal: steps.length,
    planDone: planReached,
    agentsTotal: agents.length,
    agentsRunning: agents.filter((agent) => agent.status === "running").length,
    refName: props.changes?.refName ?? null,
    aheadCount: props.changes?.aheadCount ?? 0,
    behindCount: props.changes?.behindCount ?? 0,
  };
}

/** Check if the panel has no meaningful content to display. */
export function isOverviewEmpty(props: OverviewLayoutProps): boolean {
  return (
    !props.activePlan &&
    !props.activeProposedPlan?.planMarkdown &&
    (props.subagents?.length ?? 0) === 0 &&
    (props.overviewItems?.length ?? 0) === 0 &&
    (props.changes?.files.length ?? 0) === 0 &&
    !props.pullRequest &&
    !props.sourceControlActions &&
    !props.branchControl
  );
}

/** Extract the changes item from the overview items array. */
export function pickChangesItem(
  overviewItems: ReadonlyArray<OverviewPanelItem> | undefined,
): OverviewPanelItem | undefined {
  return overviewItems?.find((item) => item.icon === "changes");
}

/** Calculate plan completion percentage (0–100). */
export function planPercent(summary: OverviewSummary): number {
  if (summary.planTotal === 0) return 0;
  return Math.round((summary.planDone / summary.planTotal) * 100);
}

/** Check if the pull request has any review data (approved or requested). */
export function hasReviews(pullRequest: { reviewsApproved?: number; reviewsRequested?: number }) {
  return (
    typeof pullRequest.reviewsApproved === "number" ||
    typeof pullRequest.reviewsRequested === "number"
  );
}
