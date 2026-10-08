import { formatCount } from "~/lib/formatCount";

import { getOverviewSummary } from "../overviewSummary.logic";
import type {
  OverviewLayoutProps,
  OverviewPullRequestCheckRun,
  OverviewPullRequestState,
} from "../overviewTypes";
import {
  CROWN_RAIL_RING_GAP_PCT,
  CROWN_RING_MAX_SEGMENTS,
  CROWN_RING_MIN_SEGMENT_PCT,
} from "./crownLayout";
import type { CrownRailItem, CrownSection, CrownTone } from "./crownSections";

/**
 * Pure view model for the Crown rail: per-icon badges, the check ring and the
 * crown face headline. Mirrors the prototype's `sum()`, `headline()` and
 * `segRing()` (output/overview-concepts/rail-island.html).
 */

export type CheckRingState = "pass" | "fail" | "running" | "queued";

export interface CheckRingSegment {
  /** Run id, or `group:<state>` once the ring collapses. Stable across updates so arcs animate. */
  readonly key: string;
  readonly state: CheckRingState;
  /** Drawn length in `pathLength=100` units; the dash gap is `100 - len`. */
  readonly len: number;
  /** `stroke-dashoffset`. */
  readonly offset: number;
}

export type CrownCiState = "fail" | "running" | "pass" | "none";
export type CrownPrState = "open" | "draft" | "merged" | "closed";

export interface CrownRailSummary {
  /** Outside a git repository the source-control icons are hidden and never headline. */
  readonly isGitRepo: boolean;
  readonly branch: { readonly badge: string; readonly ahead: number };
  readonly changes: { readonly count: number };
  readonly checks: {
    readonly segments: ReadonlyArray<CheckRingSegment>;
    readonly ci: CrownCiState;
    readonly passed: number;
    readonly failed: number;
    readonly total: number;
  };
  /** `done`/`total` count completed steps only, like the prototype's arc and "Plan d/t". */
  readonly plan: {
    readonly pct: number;
    readonly done: number;
    readonly total: number;
    readonly active: boolean;
    readonly stepLabel: string | null;
  };
  /**
   * `count` is every agent the Agents tab lists (workflow coordinators never
   * count), `live` the running, queued and waiting ones.
   */
  readonly agents: { readonly count: number; readonly live: number };
  readonly pr: { readonly state: CrownPrState | null; readonly conflict: boolean };
  readonly notes: { readonly count: number };
  /** Commits a push would publish; `ready` lights the Push icon. */
  readonly ship: { readonly count: number; readonly ready: boolean };
}

export interface CrownHeadline {
  readonly section: CrownSection;
  readonly tone: CrownTone;
  /** The face's status dot pulses: only while checks are running. */
  readonly pulse: boolean;
  readonly title: string;
  readonly sub: string;
}

export function checkRingStateForTone(tone: OverviewPullRequestCheckRun["tone"]): CheckRingState {
  switch (tone) {
    case "success":
      return "pass";
    case "failure":
    case "error":
      return "fail";
    case "running":
      return "running";
    default:
      return "queued";
  }
}

export interface CrownCheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Running plus pending: what the face reports as "in progress". */
  readonly inProgress: number;
  /** Failed run names, in run order. */
  readonly failedNames: ReadonlyArray<string>;
  readonly ci: CrownCiState;
}

/**
 * Tallies the latest check runs. Skipped / cancelled runs draw as queued on the
 * ring but are neither in progress nor failing, so a skipped job can't pin the
 * crown on "Checks running". With no run rows the rollup status decides `ci`.
 */
export function countCrownChecks(
  pullRequest: OverviewPullRequestState | null | undefined,
): CrownCheckCounts {
  const runs = pullRequest?.latestRuns ?? [];
  let passed = 0;
  let inProgress = 0;
  const failedNames: string[] = [];
  for (const run of runs) {
    if (run.tone === "success") passed += 1;
    else if (run.tone === "failure" || run.tone === "error") failedNames.push(run.name);
    else if (run.tone === "running" || run.tone === "pending") inProgress += 1;
  }
  if (runs.length === 0) {
    const status = pullRequest?.checkStatus;
    const failed = status?.kind === "failed" ? status.failedChecks.map((check) => check.name) : [];
    const ci: CrownCiState =
      status?.kind === "failed"
        ? "fail"
        : status?.kind === "running" || status?.kind === "pending"
          ? "running"
          : status?.kind === "passed"
            ? "pass"
            : "none";
    return {
      total: 0,
      passed: 0,
      failed: ci === "fail" ? Math.max(1, failed.length) : 0,
      inProgress: 0,
      failedNames: failed,
      ci,
    };
  }
  const ci: CrownCiState = failedNames.length > 0 ? "fail" : inProgress > 0 ? "running" : "pass";
  return { total: runs.length, passed, failed: failedNames.length, inProgress, failedNames, ci };
}

const NO_CHECKS: CrownCheckCounts = {
  total: 0,
  passed: 0,
  failed: 0,
  inProgress: 0,
  failedNames: [],
  ci: "none",
};

/** A change request's reported state, or null while no source has reported one. */
export function crownKnownPrState(
  state: string | undefined,
): Exclude<CrownPrState, "draft"> | null {
  const normalized = state?.toLowerCase();
  return normalized === "open" || normalized === "merged" || normalized === "closed"
    ? normalized
    : null;
}

/** The PR state the rail colours by; an unreported state reads as open. */
export function crownPrState(
  pullRequest: OverviewPullRequestState | null | undefined,
): CrownPrState | null {
  if (!pullRequest || typeof pullRequest.number !== "number") return null;
  const state = crownKnownPrState(pullRequest.state);
  if (state === "merged" || state === "closed") return state;
  return pullRequest.isDraft ? "draft" : "open";
}

/**
 * Commits a push would publish: the upstream ahead count, or for a branch that
 * was never pushed, its commits ahead of the default branch.
 */
export function crownShipCount(changes: OverviewLayoutProps["changes"]): number {
  if (!changes) return 0;
  if (changes.aheadCount > 0) return changes.aheadCount;
  if (changes.hasUpstream === false) return Math.max(0, changes.aheadOfDefaultCount ?? 0);
  return 0;
}

/**
 * The prototype's `segRing()`: one arc per run in `pathLength=100` units, each
 * `100/n - gap` long (at least 0.6) and offset to start `gap/2` into its slot.
 * Above `maxSegments` runs, arcs merge into one per state (fail, running,
 * queued, pass) sized by count.
 */
export function buildCheckRingSegments(
  runs: ReadonlyArray<Pick<OverviewPullRequestCheckRun, "id" | "tone">>,
  opts: { readonly gapPct?: number; readonly maxSegments?: number } = {},
): CheckRingSegment[] {
  const gap = opts.gapPct ?? CROWN_RAIL_RING_GAP_PCT;
  const maxSegments = opts.maxSegments ?? CROWN_RING_MAX_SEGMENTS;
  const n = runs.length;
  if (n === 0) return [];

  const slots: Array<{ key: string; state: CheckRingState; weight: number }> =
    n <= maxSegments
      ? runs.map((run) => ({ key: run.id, state: checkRingStateForTone(run.tone), weight: 1 }))
      : collapseRingStates(runs);

  const segments: CheckRingSegment[] = [];
  let start = 0;
  for (const slot of slots) {
    const slotLen = (100 * slot.weight) / n;
    segments.push({
      key: slot.key,
      state: slot.state,
      len: Math.max(slotLen - gap, CROWN_RING_MIN_SEGMENT_PCT),
      offset: -(start + gap / 2),
    });
    start += slotLen;
  }
  return segments;
}

const COLLAPSED_RING_ORDER: ReadonlyArray<CheckRingState> = ["fail", "running", "queued", "pass"];

function collapseRingStates(
  runs: ReadonlyArray<Pick<OverviewPullRequestCheckRun, "tone">>,
): Array<{ key: string; state: CheckRingState; weight: number }> {
  const counts: Record<CheckRingState, number> = { fail: 0, running: 0, queued: 0, pass: 0 };
  for (const run of runs) counts[checkRingStateForTone(run.tone)] += 1;
  return COLLAPSED_RING_ORDER.filter((state) => counts[state] > 0).map((state) => ({
    key: `group:${state}`,
    state,
    weight: counts[state],
  }));
}

export function buildCrownRailSummary(
  layout: OverviewLayoutProps,
  input: { readonly isGitRepo: boolean; readonly notesCount?: number },
): CrownRailSummary {
  const summary = getOverviewSummary(layout);
  const checks = input.isGitRepo ? countCrownChecks(layout.pullRequest) : NO_CHECKS;
  const steps = layout.activePlan?.steps ?? [];
  const activeStep = steps.find((step) => step.status === "inProgress") ?? null;
  const planDone = steps.filter((step) => step.status === "completed").length;
  const shipCount = input.isGitRepo ? crownShipCount(layout.changes) : 0;
  const prState = input.isGitRepo ? crownPrState(layout.pullRequest) : null;
  return {
    isGitRepo: input.isGitRepo,
    branch: {
      badge: summary.aheadCount > 0 ? `↑${summary.aheadCount}` : "",
      ahead: summary.aheadCount,
    },
    changes: { count: summary.fileCount },
    checks: {
      segments: input.isGitRepo ? buildCheckRingSegments(layout.pullRequest?.latestRuns ?? []) : [],
      ci: checks.ci,
      passed: checks.passed,
      failed: checks.failed,
      total: checks.total,
    },
    plan: {
      pct: steps.length > 0 ? Math.round((planDone / steps.length) * 100) : 0,
      done: planDone,
      total: steps.length,
      active: activeStep !== null,
      stepLabel: activeStep?.step ?? null,
    },
    agents: { count: summary.agentsTotal, live: summary.agentsRunning },
    pr: {
      state: prState,
      conflict: prState !== null && layout.pullRequest?.hasMergeConflicts === true,
    },
    notes: { count: input.notesCount ?? 0 },
    ship: { count: shipCount, ready: shipCount > 0 },
  };
}

/**
 * What a rail button's badges, rings and colours say, for screen readers (its
 * `aria-description`; the label stays the section name). Null when there is
 * nothing beyond the label.
 */
export function crownRailItemDescription(
  item: CrownRailItem,
  summary: CrownRailSummary,
): string | null {
  switch (item.key) {
    case "branch":
      return summary.branch.ahead > 0
        ? `${formatCount(summary.branch.ahead, "commit")} ahead`
        : null;
    case "changes":
      return summary.changes.count > 0
        ? `${formatCount(summary.changes.count, "file")} changed`
        : "No changes";
    case "checks": {
      const { ci, passed, failed, total } = summary.checks;
      const tally = total > 0 ? `${passed} of ${total} passed` : null;
      if (ci === "fail") return `${formatCount(failed, "check")} failing`;
      if (ci === "running") return tally ? `Running, ${tally}` : "Running";
      if (ci === "pass") return "All checks passed";
      return "No checks";
    }
    case "plan":
      return summary.plan.total > 0
        ? `${summary.plan.done} of ${formatCount(summary.plan.total, "step")} done`
        : "No plan";
    case "agents": {
      const { count, live } = summary.agents;
      if (count === 0) return "No subagents";
      return live > 0
        ? `${formatCount(count, "subagent")}, ${live} active`
        : formatCount(count, "subagent");
    }
    case "pr": {
      const { state, conflict } = summary.pr;
      if (state === null) return "No pull request";
      return conflict ? `${state}, has conflicts` : state;
    }
    case "notes":
      return summary.notes.count > 0 ? formatCount(summary.notes.count, "note") : null;
    case "ship":
      return summary.ship.count > 0
        ? `${formatCount(summary.ship.count, "commit")} to push`
        : "Nothing to push";
  }
}

/** The crown face: what matters most right now. Failing > running > unpushed > plan > passed > neutral. */
export function resolveCrownHeadline(
  summary: CrownRailSummary,
  layout: OverviewLayoutProps,
): CrownHeadline {
  const checks = summary.isGitRepo ? countCrownChecks(layout.pullRequest) : NO_CHECKS;
  const refName = layout.changes?.refName ?? "";
  if (checks.ci === "fail") {
    return {
      section: "checks",
      tone: "danger",
      pulse: false,
      title: `${formatCount(checks.failed, "check")} failing`,
      sub: checks.failedNames[0] ?? "",
    };
  }
  if (checks.ci === "running") {
    return {
      section: "checks",
      tone: "warning",
      pulse: true,
      title: checks.total > 0 ? `Checks ${checks.passed}/${checks.total}` : "Checks running",
      sub: checks.inProgress > 0 ? `${checks.inProgress} in progress` : "In progress",
    };
  }
  if (summary.ship.count > 0) {
    return {
      section: "branch",
      tone: "info",
      pulse: false,
      title: `${summary.ship.count} to push`,
      sub: refName,
    };
  }
  if (summary.plan.active) {
    return {
      section: "plan",
      tone: "plan",
      pulse: false,
      title: `Plan ${summary.plan.done}/${summary.plan.total}`,
      sub: summary.plan.stepLabel ?? "",
    };
  }
  if (checks.ci === "pass") {
    const prNumber = layout.pullRequest?.number;
    return {
      section: "checks",
      tone: "success",
      pulse: false,
      title: "All checks passed",
      sub: typeof prNumber === "number" ? `PR #${prNumber}` : refName,
    };
  }
  return {
    section: summary.isGitRepo ? "branch" : "plan",
    tone: "neutral",
    pulse: false,
    title: "Overview",
    sub: refName,
  };
}
