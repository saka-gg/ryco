/**
 * What a thread has running besides its own turn (subagents, background
 * tasks), handed from the chat view to the dock on the composer.
 *
 * It travels by context, not through the composer's props: the agent roster
 * moves with every agent event, and the composer must not re-render for it.
 */
import type { BackgroundTask, BackgroundWork } from "@ryco/shared/backgroundWork";
import { createContext } from "react";

import {
  agentPanelAgentCount,
  agentWorkflowMembers,
  isActiveSubagentStatus,
  type AgentPanelModel,
  type RuntimeSubagent,
} from "../../threadWorkspaceViewModel";

export interface ThreadLiveWork {
  readonly agentPanelModel: AgentPanelModel;
  readonly work: BackgroundWork;
  /** Background work that outlived the turn; null while the turn itself works or nothing runs. */
  readonly liveness: "working" | "monitoring" | null;
  readonly connected: boolean;
  readonly mutationReady: boolean;
  readonly stoppingAll: boolean;
  /** The stop-everything interrupt: it ends every live background task, then the turn. */
  readonly onStopAll: () => void;
  readonly onStopTask: (task: BackgroundTask) => Promise<void>;
  readonly onOpenAgents: () => void;
  readonly onOpenAgent: (agentId: string) => void;
}

/** Null on the frozen phone tier and wherever no chat view provides it. */
export const ThreadLiveWorkContext = createContext<ThreadLiveWork | null>(null);

/** Agent rows an open dock lists before deferring to the Agents panel. */
export const DOCK_AGENT_ROW_LIMIT = 6;

export interface ThreadLiveWorkSummary {
  /** Whether the dock has anything of this to show. */
  readonly present: boolean;
  /** Loaded working agents (members and direct spawns, never coordinators), newest report first. */
  readonly workingAgents: ReadonlyArray<RuntimeSubagent>;
  /** Every working agent, including those of a large run no longer loaded. */
  readonly workingCount: number;
  readonly waitingCount: number;
  /** Every agent the thread has run. */
  readonly agentCount: number;
  /** "3 background tasks", with what is known about omitted details; null without tasks. */
  readonly tasksLabel: string | null;
  /** Background work the provider reports without agents or task details. */
  readonly idleLabel: string | null;
  /**
   * Stop all ends background work, so it is offered where that is the only
   * way to stop it; a turn's own agents stop with the composer's Stop.
   */
  readonly offersStopAll: boolean;
}

export function summarizeThreadLiveWork(
  input: Pick<ThreadLiveWork, "agentPanelModel" | "work" | "liveness">,
): ThreadLiveWorkSummary {
  const { agentPanelModel: model, work, liveness } = input;
  const workingAgents = [...model.workflows.flatMap(agentWorkflowMembers), ...model.directAgents]
    .filter((agent) => isActiveSubagentStatus(agent.status))
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const taskCount = work.tasks.length;
  const hasTaskInfo = taskCount > 0 || work.detailsOmitted;
  const tasksLabel = !hasTaskInfo
    ? null
    : taskCount === 0
      ? "Background work · details unavailable"
      : `${taskCount} background ${taskCount === 1 ? "task" : "tasks"}${work.detailsOmitted ? " · details limited" : ""}`;
  const idleLabel =
    liveness === null || hasTaskInfo || model.liveCount > 0
      ? null
      : liveness === "working"
        ? "Background work running"
        : "Monitoring in the background";
  return {
    present: model.liveCount > 0 || hasTaskInfo || liveness !== null,
    workingAgents,
    workingCount: model.liveCount,
    waitingCount: model.waitingCount,
    agentCount: agentPanelAgentCount(model),
    tasksLabel,
    idleLabel,
    offersStopAll: liveness !== null || hasTaskInfo,
  };
}
