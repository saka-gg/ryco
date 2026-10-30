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
import { completionReturnPresentation } from "@ryco/client-runtime/state/agentControl";
import {
  resolveDelegatedTaskStatus,
  type DelegatedTaskTone,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";

import { inboxThreadStatus, type InboxEnvironment } from "../inbox/inboxModel";

// The phone's agents sheet: one list of everything a chat set working, read
// from the same models web's Agents panel and delegation dock use. Provider
// subagents (Claude subagents, Codex collaboration agents, workflow members)
// come from the shared panel model (`deriveThreadAgentPanelModel`) and unfold
// in place; delegated Ryco tasks are threads of their own, which a row opens,
// and read by the dock's rules (`resolveDelegatedTaskStatus`).

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
  /** The activity line reports a failure. */
  readonly activityFailed: boolean;
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
  /** The chat shows last-known state: nothing reads as live, and no clock runs. */
  readonly offline: boolean;
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
  /**
   * The thread screen shows a cached or degraded snapshot (its header reads
   * Offline): what it claims runs may have long settled.
   */
  readonly offline: boolean;
  /** Result returns of the chat's delegated tasks, by child (`selectCompletionReturnsByChildThreadId`). */
  readonly completionReturns: ReadonlyMap<ThreadId, AgentControlCompletionReturn>;
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

/** What an offline chat's rows say in place of a live status, as its header does. */
const OFFLINE_LABEL = "Offline";

function subagentRow(
  agent: RuntimeSubagent,
  roster: AgentRosterIdentity,
  input: ThreadAgentsSheetInput,
): ThreadAgentRow {
  const { label, role } = resolveAgentRowIdentity(agent, roster);
  const status = SUBAGENT_STATUS_TEXT[agent.status];
  // Offline, an agent last seen live may have long settled: no live status, clock or Stop.
  const unknown = input.offline && isActiveSubagentStatus(agent.status);
  const tone = unknown ? "muted" : SUBAGENT_TONE[agent.status];
  return {
    key: `agent:${agent.id}`,
    label,
    role,
    statusLabel: unknown ? OFFLINE_LABEL : (status.word ?? status.label),
    tone,
    activity: agentActivityText(agent),
    activityFailed: tone === "failed",
    elapsed: unknown ? null : subagentElapsed(agent, input.nowMs),
    childThreadId: null,
    details: subagentDetails(agent, label),
    stop:
      input.stopReady && !input.offline
        ? subagentStopIdentity(agent, input.runtimeSessionId)
        : null,
  };
}

const DELEGATED_TONE: Readonly<Record<DelegatedTaskTone, ThreadAgentTone>> = {
  working: "working",
  attention: "attention",
  done: "done",
  danger: "failed",
  muted: "muted",
};

interface DelegatedRow {
  readonly row: ThreadAgentRow;
  /** Working, or waiting on the user: what the dock counts as working and needing you. */
  readonly live: boolean;
  readonly failed: boolean;
}

function delegatedRow(thread: SidebarThreadSummary, input: ThreadAgentsSheetInput): DelegatedRow {
  const inbox = inboxThreadStatus(thread, input.environment, input.nowMs);
  const completionReturn = input.completionReturns.get(thread.id);
  let state = inbox.state;
  let task = resolveDelegatedTaskStatus({ thread, state, completionReturn });
  let inboxLabel = inbox.label;
  // Offline, a task last seen working or waiting reads as the inbox reads an offline node's.
  if (input.offline && (task.tone === "working" || task.tone === "attention")) {
    state = "offline";
    task = resolveDelegatedTaskStatus({ thread, state, completionReturn });
    inboxLabel = OFFLINE_LABEL;
  }
  const turn = thread.latestTurn;
  const elapsed =
    task.runningSince !== null
      ? elapsedBetween(task.runningSince, null, input.nowMs)
      : turn?.state === "completed" && turn.startedAt && turn.completedAt
        ? elapsedBetween(turn.startedAt, turn.completedAt)
        : "";
  const result =
    completionReturn === undefined ? null : completionReturnPresentation(completionReturn.status);
  return {
    row: {
      key: `thread:${thread.id}`,
      label: thread.title.trim() || "Untitled task",
      role: null,
      statusLabel: task.label ?? inboxLabel,
      tone: DELEGATED_TONE[task.tone],
      // Where its result to this chat stands, as the dock's pill says it.
      activity: result?.label ?? null,
      activityFailed: result?.tone === "danger",
      elapsed: elapsed || null,
      childThreadId: thread.id,
      details: null,
      stop: null,
    },
    // A task held by a usage limit waits on neither: it is not active.
    live: state === "working" || state === "needs-input",
    failed: task.failed,
  };
}

function progressWords(working: number, failed = 0): string | null {
  const words = [
    working > 0 ? `${working} working` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter((word): word is string => word !== null);
  return words.length > 0 ? words.join(" · ") : null;
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
      status: input.offline ? null : agentWorkflowStatusText(summary),
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
      status: input.offline
        ? null
        : progressWords(
            input.panel.directAgents.filter((agent) => isActiveSubagentStatus(agent.status)).length,
          ),
      rows: input.panel.directAgents.map((agent) => subagentRow(agent, roster, input)),
    });
  }
  const children = input.delegatedChildren.map((thread) => delegatedRow(thread, input));
  const childRows = children.map((child) => child.row);
  if (childRows.length > 0) {
    sections.push({
      key: "delegated",
      title: "Delegated tasks",
      status: input.offline
        ? null
        : progressWords(
            childRows.filter((row) => row.tone === "working").length,
            children.filter((child) => child.failed).length,
          ),
      rows: childRows,
    });
  }
  return {
    sections,
    total: agentPanelAgentCount(input.panel) + childRows.length,
    live: input.offline ? 0 : input.panel.liveCount + children.filter((child) => child.live).length,
    offline: input.offline,
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
      model.live > 0
        ? `${label}, ${model.total} in all. Show agents.`
        : model.offline
          ? `${label}, offline. Show agents.`
          : `${label}. Show agents.`,
  };
}

/** The sheet's line under its title: how many are active, or that the chat is offline. */
export function threadAgentsSheetSummary(model: ThreadAgentsSheetModel): string {
  if (model.offline) return `${OFFLINE_LABEL} · ${model.total} in all`;
  return model.live > 0 ? `${model.live} active · ${model.total} in all` : `${model.total} in all`;
}
