/**
 * Claude task, subagent and workflow-progress mapping from SDK task messages.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  RuntimeSubagentId,
  RuntimeTaskId,
  type RuntimeSubagentStatus,
  type RuntimeTaskStatus,
  type SubagentRef,
  type TaskAgentLinkage,
} from "@ryco/contracts";
import {
  type ClaudeSessionContext,
  type ClaudeTaskAgentState,
  trimmedClaudeString,
} from "./ClaudeAdapter.types.ts";
import { nonNegativeInt } from "./ClaudeAdapter.usage.ts";

export const CLAUDE_SUBAGENT_ATTRIBUTION_CACHE_CAP = 256;

export function rememberClaudeSubagentAttribution<A>(
  cache: Map<string, A>,
  toolUseId: string,
  value: A,
): void {
  if (!cache.has(toolUseId) && cache.size >= CLAUDE_SUBAGENT_ATTRIBUTION_CACHE_CAP) {
    const oldestToolUseId = cache.keys().next().value;
    if (oldestToolUseId !== undefined) cache.delete(oldestToolUseId);
  }
  cache.set(toolUseId, value);
}

export function rememberClaudeSubagentLaunch(
  context: Pick<
    ClaudeSessionContext,
    "subagentLaunchInputByToolUseId" | "subagentLaunchTurnByToolUseId" | "turnState"
  >,
  toolUseId: string,
  input: Record<string, unknown>,
): void {
  rememberClaudeSubagentAttribution(context.subagentLaunchInputByToolUseId, toolUseId, input);
  if (context.turnState && !context.subagentLaunchTurnByToolUseId.has(toolUseId)) {
    rememberClaudeSubagentAttribution(
      context.subagentLaunchTurnByToolUseId,
      toolUseId,
      context.turnState.turnId,
    );
  }
}

export function claudeSubagentLaunchModel(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const model = trimmedClaudeString(input?.model);
  return model?.toLowerCase() === "inherit" ? undefined : model;
}

export function claudeTaskField(message: SDKMessage, field: string): string | undefined {
  return trimmedClaudeString((message as Record<string, unknown>)[field]);
}

/** SDK task_updated patch status → the shared wire vocabulary. */
export const CLAUDE_TASK_PATCH_STATUS: Record<string, RuntimeTaskStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  killed: "cancelled",
  paused: "idle",
};

/**
 * Resolves a stream message's parent_tool_use_id to the owning agent's
 * taskId. The Task tool's tool_use_id is remembered on task_started; any
 * subagent-forwarded block carries that id as its parent. Returns undefined
 * for parent-conversation traffic.
 */
export function agentIdForParentToolUse(
  agents: Map<string, ClaudeTaskAgentState>,
  parentToolUseId: string | null | undefined,
): string | undefined {
  if (parentToolUseId === null || parentToolUseId === undefined) {
    return undefined;
  }
  for (const agent of agents.values()) {
    if (agent.toolUseId === parentToolUseId) {
      return agent.taskId;
    }
  }
  return undefined;
}

/**
 * Linkage bundle repeated on every task.* payload for `taskId`. Reads the
 * remembered identity (from task_started) so progress/terminal rows are
 * self-describing even when the start row ages out of activity retention.
 */
export function taskLinkageFor(
  agents: Map<string, ClaudeTaskAgentState>,
  taskId: string,
): TaskAgentLinkage {
  const agent = agents.get(taskId);
  if (!agent) {
    return {};
  }
  return {
    ...(agent.backgroundAttempt !== undefined ? { attempt: agent.backgroundAttempt } : {}),
    ...(agent.taskType ? { taskType: agent.taskType } : {}),
    ...(agent.owningAgentId ? { agentId: agent.owningAgentId } : {}),
    ...(agent.description ? { title: agent.description } : {}),
    ...(agent.subagentType ? { role: agent.subagentType } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.toolUseId ? { toolUseId: agent.toolUseId } : {}),
    ...(agent.workflowName ? { workflowName: agent.workflowName } : {}),
    ...(agent.runHandles ? { runHandles: agent.runHandles } : {}),
  };
}

export const WORKFLOW_PHASE_CAP = 64;

/**
 * Members re-examined per progress tick. Bounds work on a hostile payload, not
 * a real run's size: settled members were emitted on earlier ticks, so live
 * ones are kept first and a run past the cap still reports what is moving.
 */
export const WORKFLOW_AGENT_CAP = 2000;

/** One workflow phase with its member tally (counts absent until a roster arrives). */
export interface ClaudeWorkflowPhase {
  readonly index: number;
  readonly title: string;
  readonly memberCount?: number;
  readonly activeCount?: number;
  readonly settledCount?: number;
  readonly failedCount?: number;
}

export interface ClaudeWorkflowAgentEntry {
  readonly index: number;
  readonly state: string;
  readonly label: string | undefined;
  readonly phaseIndex: number | undefined;
  readonly phaseTitle: string | undefined;
  readonly model: string | undefined;
  readonly attempt: number | undefined;
  readonly lastToolName: string | undefined;
  readonly startedAt: string | undefined;
  readonly error: string | undefined;
  readonly tokens: number | undefined;
  readonly toolCalls: number | undefined;
}

export interface ClaudeWorkflowProgress {
  readonly phases: ReadonlyArray<ClaudeWorkflowPhase>;
  readonly agents: ReadonlyArray<ClaudeWorkflowAgentEntry>;
}

/**
 * Defensive parse of the SDK's undeclared-but-real workflow_progress array on
 * task_progress messages (wire-confirmed; absent from sdk.d.ts). Unknown
 * shapes are skipped per-entry; phases and agents dedupe by index before
 * caps; a vanished field never throws. If the array disappears upstream the
 * caller keeps the coordinator row and plain task lifecycle.
 */
export function parseWorkflowProgress(value: unknown): ClaudeWorkflowProgress | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const phasesByIndex = new Map<number, string>();
  const agentsByIndex = new Map<number, ClaudeWorkflowAgentEntry>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const entryType = trimmedClaudeString(record.type);
    if (entryType === "workflow_phase") {
      const index = nonNegativeInt(record.index);
      const title = trimmedClaudeString(record.title);
      if (index !== undefined && title && !phasesByIndex.has(index)) {
        phasesByIndex.set(index, title);
      }
      continue;
    }
    if (entryType !== "workflow_agent") {
      continue;
    }
    const index = nonNegativeInt(record.index);
    const state = trimmedClaudeString(record.state);
    if (index === undefined || !state || agentsByIndex.has(index)) {
      continue;
    }
    agentsByIndex.set(index, {
      index,
      state,
      label: trimmedClaudeString(record.label),
      phaseIndex: nonNegativeInt(record.phaseIndex),
      phaseTitle: trimmedClaudeString(record.phaseTitle),
      model: trimmedClaudeString(record.model),
      attempt: nonNegativeInt(record.attempt),
      lastToolName: trimmedClaudeString(record.lastToolName),
      startedAt: trimmedClaudeString(record.startedAt),
      error: trimmedClaudeString(record.error),
      tokens: nonNegativeInt(record.tokens),
      toolCalls: nonNegativeInt(record.toolCalls),
    });
  }
  if (phasesByIndex.size === 0 && agentsByIndex.size === 0) {
    return undefined;
  }
  // Tallied from the whole roster before the per-tick cap, so totals stay
  // true however large the run.
  const tallies = new Map<
    number,
    { members: number; active: number; settled: number; failed: number }
  >();
  for (const agent of agentsByIndex.values()) {
    if (agent.phaseIndex === undefined) continue;
    const tally = tallies.get(agent.phaseIndex) ?? { members: 0, active: 0, settled: 0, failed: 0 };
    const status = workflowAgentStatus(agent);
    tally.members += 1;
    if (status === "completed" || status === "failed") tally.settled += 1;
    else tally.active += 1;
    if (status === "failed") tally.failed += 1;
    tallies.set(agent.phaseIndex, tally);
  }
  const phases = Array.from(phasesByIndex.entries())
    .map(([index, title]): ClaudeWorkflowPhase => {
      const tally = agentsByIndex.size > 0 ? (tallies.get(index) ?? null) : undefined;
      return tally === undefined
        ? { index, title }
        : {
            index,
            title,
            memberCount: tally?.members ?? 0,
            activeCount: tally?.active ?? 0,
            settledCount: tally?.settled ?? 0,
            failedCount: tally?.failed ?? 0,
          };
    })
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_PHASE_CAP);
  const isLive = (agent: ClaudeWorkflowAgentEntry) => {
    const status = workflowAgentStatus(agent);
    return status !== "completed" && status !== "failed";
  };
  const agents = Array.from(agentsByIndex.values())
    .toSorted((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.index - b.index)
    .slice(0, WORKFLOW_AGENT_CAP)
    .toSorted((a, b) => a.index - b.index);
  return { phases, agents };
}

/**
 * Workflow progress is a sparse snapshot stream: some ticks omit phases and
 * later ticks may reveal additional ones. Keep a monotonic, index-keyed
 * roster so the coordinator's latest-state activity always carries the full
 * workflow shape observed so far.
 */
export function mergeWorkflowPhases(
  current: ReadonlyArray<ClaudeWorkflowPhase> | undefined,
  incoming: ReadonlyArray<ClaudeWorkflowPhase> | undefined,
): ReadonlyArray<ClaudeWorkflowPhase> {
  if (!incoming || incoming.length === 0) {
    return current ?? [];
  }
  const byIndex = new Map<number, ClaudeWorkflowPhase>();
  for (const phase of current ?? []) {
    byIndex.set(phase.index, phase);
  }
  for (const phase of incoming) {
    // A tick without a roster renames a phase but must not erase its tally.
    const previous = byIndex.get(phase.index);
    byIndex.set(
      phase.index,
      phase.memberCount === undefined && previous?.memberCount !== undefined
        ? { ...previous, title: phase.title }
        : phase,
    );
  }
  return Array.from(byIndex.values())
    .toSorted((left, right) => left.index - right.index)
    .slice(0, WORKFLOW_PHASE_CAP);
}

/**
 * Workflow member states from workflow_progress → shared task status.
 * Unknown states read running after startedAt, pending before it.
 */
export function workflowAgentStatus(entry: ClaudeWorkflowAgentEntry): RuntimeTaskStatus {
  switch (entry.state) {
    case "queued":
    case "pending":
      return "pending";
    case "start":
    case "running":
      return entry.startedAt === undefined ? "pending" : "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return entry.startedAt === undefined ? "pending" : "running";
  }
}

export function hasClaudeSubagentNameSignal(value: string | undefined): boolean {
  return value !== undefined && /\b(?:sub[-\s]?agent|agent|subtask|task)\b/i.test(value);
}

export function hasClaudeSubagentDescriptionSignal(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /\b(?:sub[-\s]?agent|agent|teammate|worker|delegate[sd]?|reviewer)\b/i.test(value)
  );
}

export function isClaudeSubagentTaskMessage(message: SDKMessage): boolean {
  return (
    hasClaudeSubagentNameSignal(claudeTaskField(message, "task_type")) ||
    hasClaudeSubagentNameSignal(claudeTaskField(message, "last_tool_name")) ||
    hasClaudeSubagentDescriptionSignal(claudeTaskField(message, "description")) ||
    hasClaudeSubagentDescriptionSignal(claudeTaskField(message, "summary"))
  );
}

export function claudeTaskSubagentStatus(
  status: "starting" | "running" | "completed" | "failed" | "stopped",
): RuntimeSubagentStatus {
  return status;
}

export function claudeTaskCompletionStatus(
  status: "completed" | "failed" | "stopped",
): Extract<RuntimeSubagentStatus, "completed" | "failed" | "stopped"> {
  return status;
}

export function claudeTaskMetadata(message: SDKMessage): Record<string, unknown> | undefined {
  const metadata = Object.fromEntries(
    [
      ["source", "claude.task"],
      ["taskType", claudeTaskField(message, "task_type")],
      ["lastToolName", claudeTaskField(message, "last_tool_name")],
    ].filter(([, value]) => value !== undefined),
  );
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function makeClaudeTaskSubagentRef(
  existing: SubagentRef | undefined,
  message: SDKMessage & { readonly task_id: string },
  linkage?: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  },
): SubagentRef {
  const taskType = claudeTaskField(message, "task_type");
  const lastToolName = claudeTaskField(message, "last_tool_name");
  const description = claudeTaskField(message, "description") ?? existing?.description;
  const label = taskType ?? lastToolName ?? existing?.label ?? "Claude task";
  const taskMetadata = claudeTaskMetadata(message);
  const metadata: Record<string, unknown> = {};
  if (existing?.metadata) {
    Object.assign(metadata, existing.metadata);
  }
  if (taskMetadata) {
    Object.assign(metadata, taskMetadata);
  }
  return {
    subagentId: existing?.subagentId ?? RuntimeSubagentId.make(`claude-task:${message.task_id}`),
    origin: "native",
    capability: "summary",
    label,
    ...(description && { description }),
    ...((linkage?.model ?? existing?.model) ? { model: linkage?.model ?? existing?.model } : {}),
    ...((linkage?.effort ?? existing?.effort)
      ? { effort: linkage?.effort ?? existing?.effort }
      : {}),
    providerTaskId: RuntimeTaskId.make(message.task_id),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  };
}
