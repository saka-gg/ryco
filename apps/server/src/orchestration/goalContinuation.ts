/**
 * Goal continuation (ported from Synara's thread goals): after a clean turn on a thread whose
 * provider does not pursue goals on its own, the server starts the next turn toward the goal
 * through the shared server wake fence. It stops when the agent reports the goal complete or
 * blocked (`ryco_update_thread` `goalStatus`), when the person pauses, edits or clears it, and a
 * Stop or a failed turn pauses it. Codex pursues its native goals itself and is left alone.
 *
 * Pure module, loaded with the continuation runtime: no services, no I/O, type imports only.
 *
 * @module goalContinuation
 */
import type { OrchestrationThreadShell, TurnId } from "@ryco/contracts";

/**
 * The continuation waits this long after the fence first lets it through, so a person's message
 * goes first: an older client sends its own queued message as soon as the thread is idle. (A
 * node's own follow-up queue holds the continuation at the fence while it has an entry.)
 */
export const GOAL_CONTINUATION_GRACE_MS = 5_000;

/** Automatic turns in a row, with no other message between them, before the goal pauses. */
export const GOAL_CONTINUATION_MAX_CHAIN = 25;

/**
 * Equal to the contracts' copy, which keeps clients from sending it (`goalContinuationRuntime.test.ts`
 * checks); a value import here would pull boot code into this lazily loaded module.
 */
export const GOAL_CONTINUATION_MESSAGE_ID_PREFIX = "goal-continuation:";

/** One continuation per finished turn: a replay dispatches the same command. */
export const goalContinuationIds = (threadId: string, turnId: string) => ({
  commandId: `goal-continue:${threadId}:${turnId}`,
  messageId: `${GOAL_CONTINUATION_MESSAGE_ID_PREFIX}${threadId}:${turnId}`,
});

export const isGoalContinuationMessageId = (messageId: string): boolean =>
  messageId.startsWith(GOAL_CONTINUATION_MESSAGE_ID_PREFIX);

/** The next turn's message. The `<ryco_goal>` block that leads every turn names the objective. */
export const goalContinuationPrompt = (threadId: string): string =>
  `Continue working toward this thread's goal.

The goal stays until it is done. Make concrete progress toward the whole objective, and do not redefine success around a smaller task that fits this turn.

Before you call it done, check the current state and verify every requirement against real evidence. When the whole objective is complete, call ryco_update_thread with threadId "${threadId}" and goalStatus "complete" before you end the turn, so Ryco stops starting new turns.

If the same outside blocker has prevented meaningful progress for three goal turns in a row, call ryco_update_thread with threadId "${threadId}" and goalStatus "blocked", so Ryco pauses the goal instead of looping. Hard, unfinished or unclear work is not a blocker.`;

type GoalShell = Pick<
  OrchestrationThreadShell,
  "goal" | "archivedAt" | "lineage" | "interactionMode" | "hasActionableProposedPlan" | "latestTurn"
>;

/**
 * Whether the server pursues this thread's goal: active, confirmed as not native to the
 * provider (`unsupported`; a pending edit waits for its sync), and a chat of its own (a
 * delegated task is driven by its parent).
 */
export const pursuesGoal = (shell: GoalShell): boolean =>
  shell.goal?.status === "active" &&
  shell.goal.synchronization?.state === "unsupported" &&
  shell.archivedAt === null &&
  shell.lineage?.relationship !== "delegated";

/** The milliseconds of an ISO time, or null. */
const instantMs = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The finished turn a continuation would follow, or null. Only a turn that ended while this
 * process ran counts: after a restart the goal waits for a person, like a held queue. And only a
 * turn that ended after the goal's last change: a resumed or edited goal waits for its next turn
 * (the resume's own turn, or the person's) instead of continuing one from before. A plan waiting
 * for the person, or Plan mode, never continues on its own.
 */
export const goalContinuationSourceTurn = (
  shell: GoalShell,
  observedSinceMs: number,
): TurnId | null => {
  if (!pursuesGoal(shell)) return null;
  if (shell.interactionMode === "plan" || shell.hasActionableProposedPlan) return null;
  const turn = shell.latestTurn;
  if (turn?.state !== "completed") return null;
  const completedAtMs = instantMs(turn.completedAt);
  if (completedAtMs === null || completedAtMs < observedSinceMs) return null;
  const goalChangedAtMs = instantMs(shell.goal?.updatedAt);
  if (goalChangedAtMs !== null && completedAtMs < goalChangedAtMs) return null;
  return turn.turnId;
};

/**
 * The failed turn that pauses the goal, or null. A usage limit does not pause it: the limit's own
 * resume carries on, and the clean turn after it continues the goal. A turn that failed before the
 * goal's last change (a resume, a new goal) does not undo that change.
 */
export const goalPausingFailedTurn = (
  shell: GoalShell,
  input: { readonly observedSinceMs: number; readonly usageLimited: boolean },
): TurnId | null => {
  if (!pursuesGoal(shell) || input.usageLimited) return null;
  const turn = shell.latestTurn;
  if (turn?.state !== "error") return null;
  const endedAtMs = instantMs(turn.completedAt) ?? instantMs(turn.requestedAt);
  if (endedAtMs === null || endedAtMs < input.observedSinceMs) return null;
  const goalChangedAtMs = instantMs(shell.goal?.updatedAt);
  if (goalChangedAtMs !== null && endedAtMs < goalChangedAtMs) return null;
  return turn.turnId;
};

/**
 * How long a capped request's task whose goal will continue its finished turn keeps its delegation
 * slot after the slot runtime first finds it idle: the grace (which starts no earlier), a few held
 * rechecks and the dispatch. So the grace never frees the slot for another task.
 */
export const GOAL_CONTINUATION_PENDING_MS = 60_000;

export const GOAL_CHAIN_PAUSE_NOTICE = {
  summary: "Goal paused",
  detail: `Ryco paused the goal after ${GOAL_CONTINUATION_MAX_CHAIN} automatic turns in a row. Resume the goal to keep going.`,
} as const;
