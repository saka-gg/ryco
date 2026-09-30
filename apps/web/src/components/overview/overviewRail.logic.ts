import type { ActivePlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import type { OverviewChanges, OverviewPullRequestState } from "./overviewTypes";

/**
 * The one status vocabulary the collapsed rail speaks: a single dot per icon.
 * `null` means "nothing worth a dot" — the icon alone carries the item.
 */
export type OverviewRailTone = "success" | "warning" | "error" | "running" | "pending" | "primary";

export interface OverviewRailStatus {
  /** Short value shown beside the label once the rail expands. */
  value: string;
  tone: OverviewRailTone | null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Summarize CI runs into the rail's value + dot, failures first. */
export function resolveOverviewRailChecks(
  pullRequest: Pick<OverviewPullRequestState, "latestRuns" | "checksLoading" | "checksError">,
): OverviewRailStatus {
  let passed = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  for (const run of pullRequest.latestRuns) {
    if (run.tone === "success") passed += 1;
    else if (run.tone === "failure" || run.tone === "error") failed += 1;
    else if (run.tone === "running") running += 1;
    else if (run.tone === "pending") pending += 1;
  }
  const total = pullRequest.latestRuns.length;
  if (failed > 0) return { value: `${failed} failing`, tone: "error" };
  if (running > 0) return { value: `${running} running`, tone: "running" };
  if (pending > 0) return { value: `${pending} pending`, tone: "pending" };
  if (total > 0) {
    return { value: `${passed}/${total} passed`, tone: passed === total ? "success" : null };
  }
  if (pullRequest.checksError) {
    return {
      value: pullRequest.checksError.kind === "terminal" ? "Unavailable" : "Retrying",
      tone: "warning",
    };
  }
  if (pullRequest.checksLoading) return { value: "Loading…", tone: null };
  return { value: "None reported", tone: null };
}

/**
 * Plan progress. Mirrors the overview's "reached" count (completed plus the
 * in-progress step) so the rail and the phone overview never disagree.
 */
export function resolveOverviewRailPlan(input: {
  activePlan: ActivePlanState | null;
  hasProposedPlan: boolean;
}): OverviewRailStatus | null {
  const steps = input.activePlan?.steps ?? [];
  if (steps.length > 0) {
    const completed = steps.filter((step) => step.status === "completed").length;
    const inProgress = steps.some((step) => step.status === "inProgress");
    const reached = completed + (inProgress ? 1 : 0);
    return {
      value: `${reached}/${steps.length}`,
      tone: completed === steps.length ? "success" : inProgress ? "running" : null,
    };
  }
  if (input.activePlan?.explanation) return { value: "In progress", tone: "running" };
  if (input.hasProposedPlan) return { value: "Proposed", tone: "primary" };
  return null;
}

export function resolveOverviewRailAgents(
  subagents: ReadonlyArray<Pick<ThreadSubagentView, "status">>,
): OverviewRailStatus | null {
  if (subagents.length === 0) return null;
  const running = subagents.filter((agent) => agent.status === "running").length;
  if (running > 0) return { value: `${running} running`, tone: "running" };
  const failed = subagents.filter((agent) => agent.status === "failed").length;
  if (failed > 0) return { value: `${failed} to review`, tone: "error" };
  return { value: plural(subagents.length, "agent"), tone: null };
}

export interface OverviewRailChangesStatus {
  fileCount: number;
  insertions: number;
  deletions: number;
  /** Uncommitted work is the one change state worth a dot. */
  tone: OverviewRailTone | null;
}

export function resolveOverviewRailChanges(
  changes: OverviewChanges | undefined,
): OverviewRailChangesStatus {
  const files = changes?.files ?? [];
  const hasLocal = files.some((file) => file.category !== "committed");
  return {
    fileCount: files.length,
    insertions: changes?.insertions ?? 0,
    deletions: changes?.deletions ?? 0,
    tone: hasLocal ? "primary" : null,
  };
}

export interface OverviewRailEnvironment {
  label: string;
  status: string;
  tone: OverviewRailTone | null;
}

const CONNECTION_STATE_LABEL: Record<string, string> = {
  connecting: "Connecting",
  error: "Connection error",
  disconnected: "Disconnected",
};

/**
 * The environment item only earns a slot when it says something: the thread's
 * machine is unreachable, remote, or one of several the project spans. A plain
 * local thread on a single machine has no environment worth showing.
 */
export function resolveOverviewRailEnvironment(input: {
  unavailable: { label: string; connectionState: string } | null;
  active: { label: string; isPrimary: boolean } | null;
  hasMultipleEnvironments: boolean;
}): OverviewRailEnvironment | null {
  if (input.unavailable) {
    const state = input.unavailable.connectionState;
    return {
      label: input.unavailable.label,
      status: CONNECTION_STATE_LABEL[state] ?? "Unavailable",
      tone: state === "connecting" ? "pending" : state === "error" ? "error" : "warning",
    };
  }
  if (input.active && (!input.active.isPrimary || input.hasMultipleEnvironments)) {
    return { label: input.active.label, status: "Connected", tone: null };
  }
  return null;
}
