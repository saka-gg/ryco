import { derivePhase, isLatestTurnSettled, isPlanFollowUpReady } from "../session/session-logic.ts";
import type { SidebarThreadSummary } from "./types.ts";

export type ThreadActivityStatus =
  | "approval"
  | "input"
  | "working"
  | "connecting"
  | "plan-ready"
  | "monitoring"
  | "idle";

export function deriveThreadActivityStatus(
  thread: Pick<
    SidebarThreadSummary,
    | "session"
    | "latestTurn"
    | "interactionMode"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "backgroundLiveness"
  >,
): ThreadActivityStatus {
  // A provider can be running while blocked on a real request. Those requests
  // outrank work; a saved plan is different and cannot block a running turn.
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  const phase = derivePhase(thread.session);
  if (
    phase === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness === "working"
  )
    return "working";
  if (phase === "connecting") return "connecting";
  if (
    isPlanFollowUpReady({
      interactionMode: thread.interactionMode,
      latestTurnSettled: isLatestTurnSettled(thread.latestTurn, thread.session),
      hasPendingUserInput: thread.hasPendingUserInput,
      hasActionableProposedPlan: thread.hasActionableProposedPlan,
    })
  )
    return "plan-ready";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return "idle";
}

/**
 * Start of the running turn, for a working thread's ticking clock. Background
 * liveness has no turn clock, so a row showing it falls back to recency.
 */
export function resolveRunningSince(
  thread: Pick<SidebarThreadSummary, "latestTurn">,
): string | null {
  const turn = thread.latestTurn;
  return turn?.state === "running" ? (turn.startedAt ?? turn.requestedAt) : null;
}
