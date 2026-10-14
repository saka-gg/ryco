/**
 * Pure state for the chat's agent spawn row: which agents one spawn batch (a
 * workflow run or a turn's direct spawns) holds, and its live counts. Read
 * from the shared agent panel model at render time; the row never carries a
 * roster of its own.
 */
import {
  agentWorkflowMembers,
  isActiveSubagentStatus,
  summarizeAgentWorkflow,
  type AgentPanelModel,
  type RuntimeSubagent,
} from "../../threadWorkspaceViewModel";

export interface AgentSpawnRef {
  /** Workflow coordinator taskId, or null for a direct-spawn batch. */
  readonly workflowId: string | null;
  readonly agentTaskIds: ReadonlyArray<string>;
}

export interface AgentSpawnSummary {
  /** The batch's agents in roster order (a workflow's members, never its coordinator). */
  readonly members: ReadonlyArray<RuntimeSubagent>;
  readonly agentCount: number;
  readonly workingCount: number;
  readonly failedCount: number;
  readonly live: boolean;
  readonly totalTokens: number;
  readonly workflowName: string | null;
  /** The working agent that reported last: whose action the row shows. */
  readonly latestWorking: RuntimeSubagent | null;
}

export function summarizeAgentSpawn(
  spawn: AgentSpawnRef,
  model: AgentPanelModel,
): AgentSpawnSummary {
  const workflowGroup = spawn.workflowId
    ? model.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  // The coordinator's own status is authoritative for workflows: dynamic
  // spawns mean the member list can be momentarily all-settled while the run
  // is still mid-flight (summarizeAgentWorkflow owns that rule).
  const workflow = workflowGroup ? summarizeAgentWorkflow(workflowGroup) : null;
  const memberIds = new Set(spawn.agentTaskIds);
  const members = workflowGroup
    ? agentWorkflowMembers(workflowGroup)
    : model.directAgents.filter((agent) => memberIds.has(agent.id));
  const working = members.filter((agent) => isActiveSubagentStatus(agent.status));
  const latestWorking = working.reduce<RuntimeSubagent | null>(
    (latest, agent) => (latest === null || agent.updatedAt > latest.updatedAt ? agent : latest),
    null,
  );
  return {
    members,
    agentCount: Math.max(
      workflow?.memberCount ?? members.length,
      Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
    ),
    // One steady in-flight presentation: waiting and stalled agents read as
    // working; only settled states differentiate.
    workingCount: workflow?.workingCount ?? working.length,
    failedCount:
      workflow?.failedCount ?? members.filter((agent) => agent.status === "failed").length,
    live: workflow?.live ?? working.length > 0,
    // Same rule as the panel footer: providers may aggregate member usage into
    // the coordinator, so count the coordinator only when no members exist.
    totalTokens:
      workflow?.totalTokens ??
      members.reduce((sum, agent) => sum + (agent.usage?.totalTokens ?? 0), 0),
    workflowName: workflow?.name ?? null,
    latestWorking,
  };
}
