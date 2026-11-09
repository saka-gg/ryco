import {
  THREAD_GOAL_OBJECTIVE_MAX_CHARS,
  type ThreadGoal,
  type ThreadGoalStatus,
  type ThreadGoalUpdate,
} from "@ryco/contracts/thread-goal";
import { formatTokenCount } from "@ryco/shared/tokenCount";

import type { ThreadGoalSlashCommand } from "../composer/logic.ts";

/**
 * A thread's goal as people read it: web's goal header over the composer and the phone's goal
 * line in the chat's context sheet. What `/goal` does is decided here too, so both clients send
 * the same command for the same text.
 */

export const THREAD_GOAL_STATUS_LABEL: Readonly<Record<ThreadGoalStatus, string>> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Usage limit reached",
  budgetLimited: "Goal budget reached",
  complete: "Goal achieved",
};

/** The goal line's heading: its delivery state while one is under way, else its status. */
export function threadGoalHeading(goal: ThreadGoal): string {
  const synchronization = goal.synchronization;
  if (synchronization?.state === "pending") return "Updating goal…";
  if (synchronization?.state === "failed") return "Goal change failed";
  if (synchronization?.state === "unsupported" && goal.status === "active") return "Goal reminder";
  return THREAD_GOAL_STATUS_LABEL[goal.status];
}

/**
 * Seconds spent on the goal: what the node counted, plus the running turn's time while the goal
 * is active and confirmed (`runningSinceMs` is when this client saw the turn start).
 */
export function threadGoalElapsedSeconds(
  goal: ThreadGoal,
  nowMs: number,
  runningSinceMs: number,
  isRunning: boolean,
): number {
  const liveSeconds =
    goal.status === "active" && isRunning && goal.synchronization === undefined
      ? Math.max(0, Math.floor((nowMs - runningSinceMs) / 1_000))
      : 0;
  return goal.timeUsedSeconds + liveSeconds;
}

/** `4:05`, `1:02:09`. */
export function formatThreadGoalElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** "12k tokens", "12k / 50k tokens"; null for a reminder-only goal, whose usage is not tracked. */
export function threadGoalUsageLabel(goal: ThreadGoal): string | null {
  if (goal.synchronization?.state === "unsupported") return null;
  const budget = goal.tokenBudget === null ? "" : ` / ${formatTokenCount(goal.tokenBudget)}`;
  return `${formatTokenCount(goal.tokensUsed)}${budget} tokens`;
}

/** A goal that stopped on its own (paused, blocked, out of budget or usage) can be resumed. */
export function threadGoalCanResume(status: ThreadGoalStatus): boolean {
  return (
    status === "paused" ||
    status === "blocked" ||
    status === "usageLimited" ||
    status === "budgetLimited"
  );
}

/** The provider receives the goal with each message, but nothing continues or counts on its own. */
export const THREAD_GOAL_REMINDER_NOTE =
  "While active, this provider receives the goal with each message. Automatic continuation and goal usage tracking are unavailable.";

/** What a `/goal` message does on a thread (`parseThreadGoalSlashCommand` reads the text). */
export type ThreadGoalCommandPlan =
  /** Show the goal (or that there is none); nothing is sent. */
  | { readonly kind: "show" }
  /** Nothing is sent; the reason is shown and the draft stays. */
  | { readonly kind: "refuse"; readonly title: string; readonly message: string }
  | { readonly kind: "clear" }
  /**
   * `thread.goal.set` with this update. `startTurn` when the thread is idle and the goal becomes
   * active: the node starts the turn that pursues it.
   */
  | {
      readonly kind: "set";
      readonly update: ThreadGoalUpdate;
      readonly startTurn: boolean;
    };

export function planThreadGoalCommand(
  command: ThreadGoalSlashCommand,
  context: { readonly hasGoal: boolean; readonly running: boolean },
): ThreadGoalCommandPlan {
  if (command.action === "show") return { kind: "show" };
  if (command.action !== "set" && !context.hasGoal) {
    return {
      kind: "refuse",
      title: "No goal set",
      message: "Use /goal followed by an objective first.",
    };
  }
  switch (command.action) {
    case "clear":
      return { kind: "clear" };
    case "pause":
      return { kind: "set", update: { status: "paused" }, startTurn: false };
    case "resume":
      return { kind: "set", update: { status: "active" }, startTurn: !context.running };
    case "set":
      if (command.objective.length > THREAD_GOAL_OBJECTIVE_MAX_CHARS) {
        return {
          kind: "refuse",
          title: "Goal is too long",
          message: `Keep the objective under ${THREAD_GOAL_OBJECTIVE_MAX_CHARS.toLocaleString("en-US")} characters.`,
        };
      }
      return {
        kind: "set",
        update: { objective: command.objective, status: "active" },
        startTurn: !context.running,
      };
  }
}
