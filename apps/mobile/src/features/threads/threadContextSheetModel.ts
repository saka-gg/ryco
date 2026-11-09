import {
  completionReturnPresentation,
  type AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";
import { isDelegatedThreadLineage } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, ThreadGoalStatus, ThreadId } from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";
import type { ThreadLineage } from "@ryco/contracts/orchestration";

import type { ThreadHeaderModel } from "./threadHeaderModel";

/** The dot in the title pill and the context sheet's status word share one tone. */
export type ThreadStatusTone = "working" | "attention" | "ready" | "muted";

export function threadStatusTone(statusLabel: ThreadHeaderModel["statusLabel"]): ThreadStatusTone {
  switch (statusLabel) {
    case "Running":
      return "working";
    case "Needs approval":
    case "Input needed":
      return "attention";
    case "Ready":
      return "ready";
    case "Archived":
    case "Offline":
      return "muted";
  }
}

/** The pill's spoken label: title, status and where it works. */
/** What the header's title pill shows: kept this small so the header only rebuilds for it. */
export type ThreadTitlePillView = Pick<
  ThreadHeaderModel,
  "title" | "statusLabel" | "projectLabel" | "worktreeLabel" | "branchLabel"
> & {
  /** A goal the agent pursues: spoken with the pill, the goal itself in the context card. */
  readonly goal?: ThreadTitlePillGoal | null;
  readonly badge: ThreadProjectBadgeView;
};

/** What the project's colored badge needs: its icon if it has one, else its initial. */
export interface ThreadProjectBadgeView {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly customAvatarContentHash: string | null;
  readonly name: string;
}

export type ThreadTitlePillGoal = "active" | "stopped" | "complete";

/** How the pill hints at the chat's goal: pursued, stopped (paused, blocked, limited) or done. */
export function threadTitlePillGoal(
  goal: { readonly status: ThreadGoalStatus } | null | undefined,
): ThreadTitlePillGoal | null {
  if (!goal) return null;
  if (goal.status === "active") return "active";
  return goal.status === "complete" ? "complete" : "stopped";
}

const PILL_GOAL_LABEL: Readonly<Record<ThreadTitlePillGoal, string>> = {
  active: "Pursuing a goal",
  stopped: "Goal paused",
  complete: "Goal achieved",
};

export function threadTitlePillAccessibilityLabel(
  model: Pick<
    ThreadTitlePillView,
    "title" | "statusLabel" | "projectLabel" | "worktreeLabel" | "goal"
  >,
): string {
  const goal = model.goal ? ` ${PILL_GOAL_LABEL[model.goal]}.` : "";
  return `${model.title}. ${model.statusLabel}.${goal} ${model.projectLabel}, ${model.worktreeLabel}. Show details.`;
}

/** A delegated chat's way back to the chat that started it, and where its result stands. */
export interface ThreadParentLink {
  readonly threadId: ThreadId;
  readonly title: string;
  /** "Returned", "Result pending"…: null when the parent's proposals are not known here. */
  readonly resultLabel: string | null;
  readonly resultTone: AgentControlStatusTone | null;
}

export function buildThreadParentLink(input: {
  readonly lineage: ThreadLineage | null | undefined;
  /** The parent's title as this node lists it; null while its row is not loaded. */
  readonly parentTitle: string | null;
  /** This chat's result return, from the parent's Agent Control proposals. */
  readonly completionReturn: AgentControlCompletionReturn | undefined;
}): ThreadParentLink | null {
  if (!isDelegatedThreadLineage(input.lineage)) return null;
  const result =
    input.completionReturn === undefined
      ? null
      : completionReturnPresentation(input.completionReturn.status);
  return {
    threadId: input.lineage.parentThreadId,
    title: input.parentTitle?.trim() || "Parent chat",
    resultLabel: result?.label ?? null,
    resultTone: result?.tone ?? null,
  };
}
