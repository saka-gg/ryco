import type { RuntimeSubagent, RuntimeSubagentStatus } from "../../threadWorkspaceViewModel";

/**
 * A running direct subagent seen at a fixed instant; override any field. The
 * shared factory for roster tests (Agents panel, crown Subagents detail).
 */
export function makeRuntimeAgent(
  id: string,
  overrides: Partial<RuntimeSubagent> & {
    readonly status?: RuntimeSubagentStatus;
  } = {},
): RuntimeSubagent {
  const firstSeenAt = overrides.firstSeenAt ?? "2026-08-10T10:00:00.000Z";
  return {
    id,
    kind: "subagent",
    title: `Task for ${id}`,
    role: null,
    model: "gpt-5.6-sol",
    effort: "high",
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt,
    startedAt: firstSeenAt,
    completedAt: null,
    updatedAt: firstSeenAt,
    ...overrides,
  };
}
