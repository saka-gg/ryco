/**
 * How a delegated task (a child thread a chat created through Agent Control)
 * reads where its parent lists it: web's delegation dock and the phone's
 * agents sheet. Each client resolves the child's inbox state its own way (its
 * connection and presence rules differ); from that state on, the words, tone,
 * clock and failure rule are these.
 */
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";

import { completionReturnPresentation } from "../agentControl/presentation.ts";
import { resolveRunningSince } from "./threadActivityStatus.ts";
import type { SidebarThreadSummary } from "./types.ts";

/** A child's inbox state: web's states, and the phone's, which adds "settled". */
export type DelegatedTaskState =
  | "needs-input"
  | "delivery-unknown"
  | "working"
  | "connecting"
  | "limited"
  | "error"
  | "reconnecting"
  | "offline"
  | "idle"
  | "settled";

/** A child's colour: its dock bar segment, its sheet dot, its state text. */
export type DelegatedTaskTone = "working" | "attention" | "done" | "danger" | "muted";

export interface DelegatedTaskStatus {
  readonly tone: DelegatedTaskTone;
  /**
   * "Working", or "Done" or "Idle" for a resting child, by whether it ever
   * finished a turn. Null for every other state, which keeps its inbox words.
   */
  readonly label: string | null;
  /** Start of the running turn, for a ticking clock; background work has none. */
  readonly runningSince: string | null;
  /** When the child last finished a turn. */
  readonly finishedAt: string | null;
  /** In error, or its result return to the parent is blocked, failed or uncertain. */
  readonly failed: boolean;
}

function toneOf(state: DelegatedTaskState, finishedAt: string | null): DelegatedTaskTone {
  switch (state) {
    case "working":
      return "working";
    case "needs-input":
    case "limited":
      return "attention";
    case "error":
    case "delivery-unknown":
      return "danger";
    case "idle":
      // A child that never finished a turn has done nothing yet.
      return finishedAt === null ? "muted" : "done";
    case "connecting":
    case "reconnecting":
    case "offline":
    case "settled":
      return "muted";
  }
}

export function resolveDelegatedTaskStatus(input: {
  readonly thread: Pick<SidebarThreadSummary, "latestTurn" | "latestCompletedTurnAt">;
  readonly state: DelegatedTaskState;
  /** The child's result return to this parent; absent when it was created without one. */
  readonly completionReturn: AgentControlCompletionReturn | null | undefined;
}): DelegatedTaskStatus {
  const { thread, state } = input;
  const finishedAt = thread.latestCompletedTurnAt ?? thread.latestTurn?.completedAt ?? null;
  const tone = toneOf(state, finishedAt);
  return {
    tone,
    label:
      state === "working" ? "Working" : state === "idle" ? (finishedAt ? "Done" : "Idle") : null,
    runningSince: state === "working" ? resolveRunningSince(thread) : null,
    finishedAt,
    failed:
      tone === "danger" ||
      (input.completionReturn != null &&
        completionReturnPresentation(input.completionReturn.status).tone === "danger"),
  };
}
