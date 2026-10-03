import type {
  SourceControlCheckRollupItem,
  SourceControlCheckRollupItemKind,
} from "@ryco/contracts";

import { epochMillis, optionalValue } from "./internal.ts";

/** One check's state, normalized across check runs and commit status contexts. */
export type ChangeRequestCheckState =
  | "failure"
  | "cancelled"
  | "action-required"
  | "running"
  | "pending"
  | "success"
  | "neutral"
  | "skipped"
  | "unknown";

/** Display buckets. `attention` outranks everything because a red check is already actionable. */
export type ChangeRequestCheckGroup = "attention" | "running" | "completed" | "skipped";

/** The checks as one word. Running and queued checks both count as `pending`. */
export type ChangeRequestChecksOverall = "none" | "failing" | "pending" | "passing";

export interface ChangeRequestCheck {
  /** Stable identity across polls: workflow plus check name. */
  readonly id: string;
  /** The host's check name. */
  readonly name: string;
  /** `workflow / name` when another surviving check shares the name, otherwise `name`. */
  readonly label: string;
  readonly workflowName: string | null;
  readonly kind: SourceControlCheckRollupItemKind;
  readonly state: ChangeRequestCheckState;
  readonly group: ChangeRequestCheckGroup;
  readonly url: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  /** Only for finished checks with both timestamps. */
  readonly durationMs: number | null;
  /** Earlier runs of the same check that this one replaced. */
  readonly supersededRuns: number;
}

export interface ChangeRequestChecksSegment {
  readonly group: ChangeRequestCheckGroup;
  readonly count: number;
}

export interface ChangeRequestChecksSummary {
  /** Deduplicated, in the host's order (a re-run keeps the slot of the run it replaced). */
  readonly checks: ReadonlyArray<ChangeRequestCheck>;
  readonly groups: Readonly<Record<ChangeRequestCheckGroup, ReadonlyArray<ChangeRequestCheck>>>;
  /** Non-empty groups in display order: attention, running, completed, skipped. */
  readonly segments: ReadonlyArray<ChangeRequestChecksSegment>;
  readonly counts: Readonly<Record<ChangeRequestCheckState, number>> & { readonly total: number };
  readonly overall: ChangeRequestChecksOverall;
  /** e.g. "3 of 12 running · 1 failed", "All checks passed", "No checks reported". */
  readonly description: string;
  /** Checks in the attention group, for "fix" affordances. */
  readonly failing: ReadonlyArray<ChangeRequestCheck>;
}

const GROUP_ORDER: ReadonlyArray<ChangeRequestCheckGroup> = [
  "attention",
  "running",
  "completed",
  "skipped",
];

function normalizeToken(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ") ?? "";
}

function stateForToken(token: string): ChangeRequestCheckState | null {
  switch (token) {
    case "failure":
    case "failed":
    case "error":
    case "timed out":
    case "timeout":
    case "startup failure":
      return "failure";
    case "action required":
      return "action-required";
    case "cancelled":
    case "canceled":
    case "stale":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "neutral":
      return "neutral";
    case "success":
    case "successful":
    case "passed":
    case "completed successfully":
      return "success";
    case "in progress":
    case "running":
      return "running";
    case "queued":
    case "pending":
    case "waiting":
    case "requested":
    case "expected":
      return "pending";
    default:
      return null;
  }
}

/**
 * A check run reports `status` plus a `conclusion` once it finished; a status
 * context reports one state. The conclusion wins when present.
 */
export function classifyCheckState(input: {
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
}): ChangeRequestCheckState {
  const conclusion = stateForToken(normalizeToken(input.conclusion));
  if (conclusion !== null) return conclusion;
  return stateForToken(normalizeToken(input.status)) ?? "unknown";
}

export function checkStateGroup(state: ChangeRequestCheckState): ChangeRequestCheckGroup {
  switch (state) {
    case "failure":
    case "cancelled":
    case "action-required":
      return "attention";
    case "running":
    case "pending":
    // Unknown is not a pass: keep it with the unsettled checks.
    case "unknown":
      return "running";
    case "success":
    case "neutral":
      return "completed";
    case "skipped":
      return "skipped";
  }
}

interface RollupRun {
  readonly item: SourceControlCheckRollupItem;
  readonly index: number;
  readonly at: number | null;
}

/** A tie goes to the later entry: hosts list a re-run after the run it repeats. */
function isAtLeastAsNew(candidate: number | null, kept: number | null): boolean {
  if (candidate === null) return kept === null;
  return kept === null || candidate >= kept;
}

/**
 * One row per check rather than one per run of it. Re-runs of the same check
 * (same workflow and name) collapse onto the newest run; two survivors that
 * still share a name come from different workflows and are labelled
 * `workflow / name`, the way GitHub writes it.
 */
export function summarizeChangeRequestChecks(
  rollup: ReadonlyArray<SourceControlCheckRollupItem> | null | undefined,
): ChangeRequestChecksSummary {
  const newest = new Map<string, { run: RollupRun; superseded: number }>();
  (rollup ?? []).forEach((item, index) => {
    const id = `${item.workflowName ?? ""}\u0000${item.name}`;
    const run: RollupRun = {
      item,
      index,
      at: epochMillis(item.startedAt) ?? epochMillis(item.completedAt),
    };
    const kept = newest.get(id);
    if (kept === undefined) {
      newest.set(id, { run, superseded: 0 });
    } else {
      // Re-setting an existing key keeps its first position in the Map.
      newest.set(id, {
        run: isAtLeastAsNew(run.at, kept.run.at) ? run : kept.run,
        superseded: kept.superseded + 1,
      });
    }
  });

  const nameCounts = new Map<string, number>();
  for (const { run } of newest.values()) {
    nameCounts.set(run.item.name, (nameCounts.get(run.item.name) ?? 0) + 1);
  }

  const checks: ChangeRequestCheck[] = [];
  for (const [id, { run, superseded }] of newest) {
    const { item } = run;
    const state = classifyCheckState({
      status: optionalValue(item.status),
      conclusion: optionalValue(item.conclusion),
    });
    const workflowName = item.workflowName ?? null;
    const startedAtMs = epochMillis(item.startedAt);
    const completedAtMs = epochMillis(item.completedAt);
    const group = checkStateGroup(state);
    checks.push({
      id,
      name: item.name,
      label:
        workflowName !== null && (nameCounts.get(item.name) ?? 0) > 1
          ? `${workflowName} / ${item.name}`
          : item.name,
      workflowName,
      kind: item.kind,
      state,
      group,
      url: optionalValue(item.url),
      startedAtMs,
      completedAtMs,
      durationMs:
        startedAtMs !== null && completedAtMs !== null && group !== "running"
          ? Math.max(0, completedAtMs - startedAtMs)
          : null,
      supersededRuns: superseded,
    });
  }

  const groups: Record<ChangeRequestCheckGroup, ChangeRequestCheck[]> = {
    attention: [],
    running: [],
    completed: [],
    skipped: [],
  };
  const counts: Record<ChangeRequestCheckState, number> = {
    failure: 0,
    cancelled: 0,
    "action-required": 0,
    running: 0,
    pending: 0,
    success: 0,
    neutral: 0,
    skipped: 0,
    unknown: 0,
  };
  for (const check of checks) {
    groups[check.group].push(check);
    counts[check.state] += 1;
  }

  const overall: ChangeRequestChecksOverall =
    checks.length === 0
      ? "none"
      : groups.attention.length > 0
        ? "failing"
        : groups.running.length > 0
          ? "pending"
          : "passing";

  return {
    checks,
    groups,
    segments: GROUP_ORDER.filter((group) => groups[group].length > 0).map((group) => ({
      group,
      count: groups[group].length,
    })),
    counts: { ...counts, total: checks.length },
    overall,
    description: describeChecks(checks.length, counts),
    failing: groups.attention,
  };
}

function describeChecks(total: number, counts: Readonly<Record<ChangeRequestCheckState, number>>) {
  if (total === 0) return "No checks reported";
  const inFlight = counts.running + counts.pending + counts.unknown;
  const failed = counts.failure + counts.cancelled;
  const parts: string[] = [];
  if (inFlight > 0) parts.push(`${inFlight} of ${total} running`);
  if (counts["action-required"] > 0) {
    parts.push(`${counts["action-required"]} awaiting action`);
  }
  if (failed > 0) {
    parts.push(parts.length > 0 ? `${failed} failed` : `${failed} of ${total} failing`);
  }
  if (parts.length > 0) return parts.join(" · ");
  const passed = counts.success + counts.neutral + counts.skipped;
  return passed === total ? "All checks passed" : `${passed} of ${total} passing`;
}
