/**
 * Runs a device's scheduler caught up on: an occurrence that came due while
 * the device's server was not running (app closed, machine asleep or off) is
 * proposed late, once, when the server is back — its plan keeps the time it
 * was due, the proposal says when it was made. Pure: the notice surfaces
 * decide how to tell the user.
 */
import type {
  AgentControlAutomationId,
  AgentControlAutomationRunId,
  AgentControlProposal,
  AgentControlProposalId,
  IsoDateTime,
  ProjectId,
} from "@ryco/contracts";

/**
 * Proposed this long after its time, a run was missed rather than claimed by
 * a regular tick: the scheduler looks for due runs every 30 s.
 */
export const MISSED_AUTOMATION_RUN_LATENESS_MS = 2 * 60_000;

/** Catch-up runs proposed longer ago are history the Automations dialog keeps, not news. */
export const MISSED_AUTOMATION_RUN_NOTICE_WINDOW_MS = 3 * 24 * 60 * 60_000;

export interface MissedAutomationRun {
  readonly proposalId: AgentControlProposalId;
  readonly runId: AgentControlAutomationRunId;
  readonly automationId: AgentControlAutomationId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The occurrence that was missed; later ones folded into the same run follow it. */
  readonly scheduledFor: IsoDateTime;
  /** Further occurrences that passed while the server was down, folded into this run. */
  readonly laterOccurrences: number;
  /** When the server, back up, proposed the catch-up run. */
  readonly proposedAt: IsoDateTime;
  /** "waiting": approving runs it now. "expired": nobody approved the catch-up in time. */
  readonly state: "waiting" | "expired";
}

/** The missed run a proposal catches up on, or null when it is anything else. */
export function missedAutomationRunOf(
  proposal: AgentControlProposal,
  nowMs: number,
): MissedAutomationRun | null {
  const plan = proposal.plan;
  if (plan.kind !== "automationRun") return null;
  const state =
    proposal.status === "pending-user-approval"
      ? "waiting"
      : proposal.status === "expired"
        ? "expired"
        : null;
  if (state === null) return null;
  const dueMs = Date.parse(plan.scheduledFor);
  const proposedMs = Date.parse(proposal.createdAt);
  if (!Number.isFinite(dueMs) || !Number.isFinite(proposedMs)) return null;
  if (proposedMs - dueMs < MISSED_AUTOMATION_RUN_LATENESS_MS) return null;
  if (nowMs - proposedMs > MISSED_AUTOMATION_RUN_NOTICE_WINDOW_MS) return null;
  return {
    proposalId: proposal.proposalId,
    runId: plan.runId,
    automationId: plan.automationId,
    projectId: plan.execution.projectId,
    title: plan.execution.title,
    scheduledFor: plan.scheduledFor,
    laterOccurrences: plan.coalescedOccurrences,
    proposedAt: proposal.createdAt,
    state,
  };
}

/** A device's missed runs, the earliest due first. */
export function collectMissedAutomationRuns(
  proposals: Iterable<AgentControlProposal>,
  nowMs: number,
): MissedAutomationRun[] {
  const runs: MissedAutomationRun[] = [];
  for (const proposal of proposals) {
    const run = missedAutomationRunOf(proposal, nowMs);
    if (run) runs.push(run);
  }
  return runs.toSorted(
    (left, right) =>
      left.scheduledFor.localeCompare(right.scheduledFor) || left.runId.localeCompare(right.runId),
  );
}
