import {
  agentActivityText,
  agentPanelAgentCount,
  agentWorkflowMembers,
  agentWorkflowStatusText,
  buildAgentRosterIdentity,
  elapsedBetween,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  resolveAgentRowIdentity,
  settledDuration,
  SUBAGENT_STATUS_TEXT,
  summarizeAgentWorkflow,
  type AgentPanelModel,
  type AgentRosterIdentity,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
  type SubagentActivityEntry,
} from "@ryco/client-runtime/state/session";
import {
  subagentStopIdentity,
  type SubagentStopIdentity,
} from "@ryco/client-runtime/state/session/subagentStop";
import { resolveRunningSince, type SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";

import {
  inboxThreadStatus,
  type InboxEnvironment,
  type InboxThreadState,
} from "../inbox/inboxModel";

// The phone's agents sheet: one list of everything a chat set working, read
// from the same models web's Agents panel and delegation dock use. Provider
// subagents (Claude subagents, Codex collaboration agents, workflow members)
// come from the shared panel model (`deriveThreadAgentPanelModel`) and unfold
// in place; delegated Ryco tasks are threads of their own, which a row opens.

export type ThreadAgentTone = "working" | "attention" | "done" | "failed" | "muted";

export interface ThreadAgentDetails {
  /** The agent's task in full, when its row leads with a shorter label. */
  readonly title: string | null;
  /** Model, tokens and tool calls, as far as the provider reported them. */
  readonly facts: ReadonlyArray<string>;
  /** What it did most recently, oldest first. */
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  readonly outcome: { readonly text: string; readonly failed: boolean } | null;
}

export interface ThreadAgentRow {
  readonly key: string;
  readonly label: string;
  /** The agent's role, when it says more than its label. */
  readonly role: string | null;
  readonly statusLabel: string;
  readonly tone: ThreadAgentTone;
  /** What it is doing now, or how it ended. */
  readonly activity: string | null;
  /** Ticking while it works (measured to `nowMs`), frozen once it settled. */
  readonly elapsed: string | null;
  /** A delegated task's own thread, which the row opens. */
  readonly childThreadId: ThreadId | null;
  /** What a provider subagent's row unfolds; delegated tasks open instead. */
  readonly details: ThreadAgentDetails | null;
  /** Offered while the node takes changes and the provider can stop this one task. */
  readonly stop: SubagentStopIdentity | null;
}

export interface ThreadAgentSection {
  readonly key: string;
  readonly title: string;
  /** The section's own progress words ("Review · 2 working", "1 failed"), if any. */
  readonly status: string | null;
  readonly rows: ReadonlyArray<ThreadAgentRow>;
}

export interface ThreadAgentsSheetModel {
  readonly sections: ReadonlyArray<ThreadAgentSection>;
  /** Agents and delegated tasks that do (or did) work. */
  readonly total: number;
  /** Of those, the ones working or waiting (on the user or a question) now. */
  readonly live: number;
}

export interface ThreadAgentsSheetInput {
  /** The chat's shared agent panel model (`deriveThreadAgentPanelModel`). */
  readonly panel: AgentPanelModel;
  /** The chat's delegated child threads, oldest first (`selectDelegatedChildThreadsForThreadRef`). */
  readonly delegatedChildren: ReadonlyArray<SidebarThreadSummary>;
  /** The chat's node, so a child reads the state its inbox row shows. */
  readonly environment: InboxEnvironment | undefined;
  /** The chat's current provider runtime: agents an earlier runtime reported can't be stopped. */
  readonly runtimeSessionId: string | null;
  /** The node takes changes now (the thread screen's mutation readiness). */
  readonly stopReady: boolean;
  readonly nowMs: number;
}

const SUBAGENT_TONE: Readonly<Record<RuntimeSubagentStatus, ThreadAgentTone>> = {
  pending: "working",
  running: "working",
  waiting: "attention",
  idle: "muted",
  completed: "done",
  failed: "failed",
  cancelled: "muted",
  interrupted: "muted",
};

function subagentElapsed(agent: RuntimeSubagent, nowMs: number): string | null {
  // Running and waiting agents tick from their start; the rest show how long they ran.
  if (agent.status === "running" || agent.status === "waiting") {
    return agent.startedAt ? elapsedBetween(agent.startedAt, null, nowMs) || null : null;
  }
  return settledDuration(agent);
}

function subagentDetails(agent: RuntimeSubagent, label: string): ThreadAgentDetails {
  const facts = [
    formatSubagentModelLabel(agent.model, agent.effort),
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tokens` : null,
    agent.usage?.toolUses !== undefined
      ? `${agent.usage.toolUses} ${agent.usage.toolUses === 1 ? "tool call" : "tool calls"}`
      : null,
  ].filter((fact): fact is string => fact !== null);
  const outcome =
    agent.status === "failed" && agent.error
      ? { text: agent.error, failed: true }
      : agent.result
        ? { text: agent.result, failed: false }
        : null;
  return {
    title: agent.title.trim() !== label ? agent.title.trim() : null,
    facts,
    recentActivity: agent.recentActivity,
    outcome,
  };
}

function subagentRow(
  agent: RuntimeSubagent,
  roster: AgentRosterIdentity,
  input: ThreadAgentsSheetInput,
): ThreadAgentRow {
  const { label, role } = resolveAgentRowIdentity(agent, roster);
  const status = SUBAGENT_STATUS_TEXT[agent.status];
  const stop = input.stopReady ? subagentStopIdentity(agent, input.runtimeSessionId) : null;
  return {
    key: `agent:${agent.id}`,
    label,
    role,
    statusLabel: status.word ?? status.label,
    tone: SUBAGENT_TONE[agent.status],
    activity: agentActivityText(agent),
    elapsed: subagentElapsed(agent, input.nowMs),
    childThreadId: null,
    details: subagentDetails(agent, label),
    stop,
  };
}

function childTone(state: InboxThreadState, finished: boolean): ThreadAgentTone {
  switch (state) {
    case "working":
      return "working";
    case "needs-input":
    case "limited":
      return "attention";
    case "error":
    case "delivery-unknown":
      return "failed";
    case "idle":
      return finished ? "done" : "muted";
    case "connecting":
    case "reconnecting":
    case "offline":
    case "settled":
      return "muted";
  }
}

function delegatedRow(thread: SidebarThreadSummary, input: ThreadAgentsSheetInput): ThreadAgentRow {
  const status = inboxThreadStatus(thread, input.environment, input.nowMs);
  const turn = thread.latestTurn;
  const finished = turn?.state === "completed" && turn.completedAt !== null;
  const runningSince = status.state === "working" ? resolveRunningSince(thread) : null;
  const elapsed =
    runningSince !== null
      ? elapsedBetween(runningSince, null, input.nowMs)
      : finished && turn.startedAt
        ? elapsedBetween(turn.startedAt, turn.completedAt)
        : "";
  return {
    key: `thread:${thread.id}`,
    label: thread.title.trim() || "Untitled task",
    role: null,
    // A delegated task that finished reads as done, not merely idle.
    statusLabel: status.state === "idle" && finished ? "Done" : status.label,
    tone: childTone(status.state, finished),
    activity: null,
    elapsed: elapsed || null,
    childThreadId: thread.id,
    details: null,
    stop: null,
  };
}

function workingWords(count: number): string | null {
  return count > 0 ? `${count} working` : null;
}

/** Every section of the sheet, in roster order: workflows, then subagents, then delegated tasks. */
export function buildThreadAgentsSheetModel(input: ThreadAgentsSheetInput): ThreadAgentsSheetModel {
  const roster = buildAgentRosterIdentity(input.panel);
  const sections: ThreadAgentSection[] = [];
  for (const group of input.panel.workflows) {
    const summary = summarizeAgentWorkflow(group);
    const members = agentWorkflowMembers(group);
    sections.push({
      key: `workflow:${group.workflow.id}`,
      title: summary.name,
      status: agentWorkflowStatusText(summary),
      // A run that reported no members yet stands for itself.
      rows: (members.length > 0 ? members : [group.workflow]).map((agent) =>
        subagentRow(agent, roster, input),
      ),
    });
  }
  if (input.panel.directAgents.length > 0) {
    sections.push({
      key: "subagents",
      title: "Subagents",
      status: workingWords(
        input.panel.directAgents.filter((agent) => isActiveSubagentStatus(agent.status)).length,
      ),
      rows: input.panel.directAgents.map((agent) => subagentRow(agent, roster, input)),
    });
  }
  const childRows = input.delegatedChildren.map((thread) => delegatedRow(thread, input));
  if (childRows.length > 0) {
    sections.push({
      key: "delegated",
      title: "Delegated tasks",
      status: workingWords(childRows.filter((row) => row.tone === "working").length),
      rows: childRows,
    });
  }
  return {
    sections,
    total: agentPanelAgentCount(input.panel) + childRows.length,
    live:
      input.panel.liveCount +
      childRows.filter((row) => row.tone === "working" || row.tone === "attention").length,
  };
}

export interface ThreadAgentsEntry {
  readonly label: string;
  /** Something works or waits now: the control reads as live. */
  readonly live: boolean;
  readonly accessibilityLabel: string;
}

/** The thread screen's way into the sheet; null while the chat set no agents working. */
export function buildThreadAgentsEntry(model: ThreadAgentsSheetModel): ThreadAgentsEntry | null {
  if (model.sections.length === 0) return null;
  const noun = (count: number) => (count === 1 ? "agent" : "agents");
  // Active: working, or waiting on someone (web's Agents footer word).
  const label =
    model.live > 0
      ? `${model.live} ${noun(model.live)} active`
      : `${model.total} ${noun(model.total)}`;
  return {
    label,
    live: model.live > 0,
    accessibilityLabel:
      model.live > 0 ? `${label}, ${model.total} in all. Show agents.` : `${label}. Show agents.`,
  };
}
