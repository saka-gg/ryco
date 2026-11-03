/**
 * Agent-vs-background task classification shared by the server ingest path
 * and client folds. Lives in shared (not contracts) because it is runtime
 * policy, not a wire schema — `packages/contracts` stays schema-only.
 */

/**
 * Watch-loop task types: Monitor-tool tasks plus background shells (a shell
 * that outlives its turn is in practice a watch loop). Canonical single copy —
 * the server liveness registry, ingestion's agentKind stamp, and the client
 * fold's legacy fallback all classify with these sets.
 */
export const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
]);

/** Task types that are neither agents nor watch loops (plan-mode bookkeeping). */
export const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

/** Task and subagent statuses after which the work never runs again without a new attempt. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

/**
 * Whether a reported status takes a task out of the live set: a terminal status, or `idle` (a
 * resting, resumable Codex child does nothing, and an all-idle fleet must not keep a thread
 * working). The server liveness registry and the Agent Control wait wake filter both use it.
 */
export function endsTaskLiveness(status: string | undefined): boolean {
  return status !== undefined && (status === "idle" || TERMINAL_TASK_STATUSES.has(status));
}

/**
 * Agent-vs-background classification, stamped by ingestion as `agentKind` so
 * persisted rows are self-describing. A deliberate denylist: the SDK's
 * agent-flavored type names drift (subagent, local_agent, local_workflow, …)
 * and an allowlist silently dropped real subagents when "local_agent"
 * appeared. A task launched from inside a subagent (agentId set) is
 * agent-internal background work UNLESS it is itself agent-flavored — a
 * nested agent can outlive its parent and stays in the roster.
 */
export function classifyTaskAgentKind(input: {
  readonly taskType?: string | undefined;
  readonly agentId?: string | undefined;
}): "agent" | "background" {
  const { taskType, agentId } = input;
  const nonAgentType =
    taskType !== undefined && (MONITOR_TASK_TYPES.has(taskType) || INERT_TASK_TYPES.has(taskType));
  if (agentId !== undefined && agentId.trim().length > 0) {
    return taskType === undefined || nonAgentType ? "background" : "agent";
  }
  return nonAgentType ? "background" : "agent";
}
