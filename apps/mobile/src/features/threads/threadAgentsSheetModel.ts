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
  summarizeDelegatedTasks,
  type DelegatedTasksSummary,
  type DelegatedTaskSummaryInput,
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

/**
 * A row's time. A working row carries when it started rather than a measured text, so the
 * sheet's model never changes as time passes: only the row's label reads the clock.
 */
export type ThreadAgentElapsed =
  | { readonly kind: "live"; readonly since: string }
  | { readonly kind: "frozen"; readonly text: string };

/** The row's time as it reads at `nowMs`; a frozen time ignores the clock. */
export function threadAgentElapsedText(
  elapsed: ThreadAgentElapsed | null,
  nowMs: number,
): string | null {
  if (elapsed === null) return null;
  if (elapsed.kind === "frozen") return elapsed.text;
  return elapsedBetween(elapsed.since, null, nowMs) || null;
}

function frozenElapsed(text: string | null): ThreadAgentElapsed | null {
  return text ? { kind: "frozen", text } : null;
}

export interface ThreadAgentRow {
  readonly key: string;
  readonly label: string;
  /** The agent's role, when it says more than its label; a delegated task's model. */
  readonly role: string | null;
  readonly statusLabel: string;
  readonly tone: ThreadAgentTone;
  /** What it is doing now, or how it ended. */
  readonly activity: string | null;
  /** The activity line reports a failure. */
  readonly activityFailed: boolean;
  /** Ticking while it works, frozen once it settled (`threadAgentElapsedText` reads it). */
  readonly elapsed: ThreadAgentElapsed | null;
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

/** The chat's delegated tasks in counts, by web's dock rules (`summarizeDelegatedTasks`). */
export interface ThreadDelegationSummary extends DelegatedTasksSummary {
  readonly total: number;
}

export interface ThreadAgentsSheetModel {
  readonly sections: ReadonlyArray<ThreadAgentSection>;
  /** Agents and delegated tasks that do (or did) work. */
  readonly total: number;
  /** Of those, the ones working or waiting (on the user or a question) now. */
  readonly live: number;
  /** The chat shows last-known state: nothing reads as live, and no clock runs. */
  readonly offline: boolean;
  /** Null while the chat delegated nothing. */
  readonly delegation: ThreadDelegationSummary | null;
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
  /** A delegated task's model as people read it (`agentActivityModelName`); null when unknown. */
  readonly modelNameOf?: (thread: SidebarThreadSummary) => string | null;
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

function subagentElapsed(agent: RuntimeSubagent): ThreadAgentElapsed | null {
  // Running and waiting agents tick from their start; the rest show how long they ran.
  if (agent.status === "running" || agent.status === "waiting") {
    return agent.startedAt ? { kind: "live", since: agent.startedAt } : null;
  }
  return frozenElapsed(settledDuration(agent));
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
    elapsed: unknown ? null : subagentElapsed(agent),
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
  /** What the dock's counts read of it. */
  readonly summary: DelegatedTaskSummaryInput;
}

function delegatedRow(thread: SidebarThreadSummary, input: ThreadAgentsSheetInput): DelegatedRow {
  const inbox = inboxThreadStatus(thread, input.environment);
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
  const elapsed: ThreadAgentElapsed | null =
    task.runningSince !== null
      ? { kind: "live", since: task.runningSince }
      : turn?.state === "completed" && turn.startedAt && turn.completedAt
        ? frozenElapsed(elapsedBetween(turn.startedAt, turn.completedAt))
        : null;
  const result =
    completionReturn === undefined ? null : completionReturnPresentation(completionReturn.status);
  return {
    row: {
      key: `thread:${thread.id}`,
      label: thread.title.trim() || "Untitled task",
      role: input.modelNameOf?.(thread) ?? null,
      statusLabel: task.label ?? inboxLabel,
      tone: DELEGATED_TONE[task.tone],
      // Where its result to this chat stands, as the dock's pill says it.
      activity: result?.label ?? null,
      activityFailed: result?.tone === "danger",
      elapsed,
      childThreadId: thread.id,
      details: null,
      stop: null,
    },
    summary: {
      state,
      tone: task.tone,
      failed: task.failed,
      result:
        completionReturn === undefined
          ? null
          : { delivered: completionReturn.status === "delivered" },
    },
  };
}

/** Working, or waiting on the user; a task held by a usage limit waits on neither. */
function delegatedLiveCount(summary: DelegatedTasksSummary): number {
  return summary.working + summary.needsYou;
}

/**
 * The delegated tasks' state words, in the dock's order: "2 working · 1 needs you · 1 failed ·
 * 1 done". Null when none applies.
 */
export function delegatedTasksStateWords(summary: DelegatedTasksSummary): string | null {
  const words = [
    summary.working > 0 ? `${summary.working} working` : null,
    summary.needsYou > 0 ? `${summary.needsYou} needs you` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.done > 0 ? `${summary.done} done` : null,
  ].filter((word): word is string => word !== null);
  return words.length > 0 ? words.join(" · ") : null;
}

/** "2 of 3 returned", counting only tasks whose result returns here; null when none does. */
export function delegatedTasksReturnedWords(summary: DelegatedTasksSummary): string | null {
  return summary.returning > 0 ? `${summary.returned} of ${summary.returning} returned` : null;
}

function workingWords(working: number): string | null {
  return working > 0 ? `${working} working` : null;
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
        : workingWords(
            input.panel.directAgents.filter((agent) => isActiveSubagentStatus(agent.status)).length,
          ),
      rows: input.panel.directAgents.map((agent) => subagentRow(agent, roster, input)),
    });
  }
  const children = input.delegatedChildren.map((thread) => delegatedRow(thread, input));
  const childRows = children.map((child) => child.row);
  const counts = summarizeDelegatedTasks(children.map((child) => child.summary));
  const delegation = childRows.length > 0 ? { ...counts, total: childRows.length } : null;
  if (delegation !== null) {
    const words = [delegatedTasksStateWords(delegation), delegatedTasksReturnedWords(delegation)];
    sections.push({
      key: "delegated",
      title: "Delegated tasks",
      status: input.offline
        ? null
        : words.filter((word): word is string => word !== null).join(" · ") || null,
      rows: childRows,
    });
  }
  return {
    sections,
    total: agentPanelAgentCount(input.panel) + childRows.length,
    live: input.offline ? 0 : input.panel.liveCount + delegatedLiveCount(counts),
    offline: input.offline,
    delegation,
  };
}

export interface ThreadAgentsEntry {
  readonly label: string;
  /** Where the delegated tasks' results stand ("2 of 3 returned"), after the label; or null. */
  readonly detail: string | null;
  /** Something works or waits now: the control reads as live. */
  readonly live: boolean;
  readonly accessibilityLabel: string;
}

const agentNoun = (count: number) => (count === 1 ? "agent" : "agents");

/** The provider agents' part of the label: what is active now, else how many there were. */
function agentsWords(total: number, live: number): string {
  // Active: working, or waiting on someone (web's Agents footer word).
  return live > 0 ? `${live} ${agentNoun(live)} active` : `${total} ${agentNoun(total)}`;
}

function delegationEntry(
  model: ThreadAgentsSheetModel,
  delegation: ThreadDelegationSummary,
): ThreadAgentsEntry {
  const agents = model.total - delegation.total;
  const agentsLive = model.offline ? 0 : model.live - delegatedLiveCount(delegation);
  // "3 delegated · 2 working · 1 done", after the chat's own agents when it has any.
  const label = [
    agents > 0 ? agentsWords(agents, agentsLive) : null,
    `${delegation.total} delegated`,
    delegatedTasksStateWords(delegation),
  ]
    .filter((word): word is string => word !== null)
    .join(" · ");
  const detail = delegatedTasksReturnedWords(delegation);
  const spoken = detail === null ? label : `${label}, ${detail}`;
  return {
    label,
    detail,
    live: model.live > 0,
    accessibilityLabel: model.offline
      ? `${spoken}, offline. Show agents.`
      : `${spoken}. Show agents.`,
  };
}

/** The thread screen's way into the sheet; null while the chat set no agents working. */
export function buildThreadAgentsEntry(model: ThreadAgentsSheetModel): ThreadAgentsEntry | null {
  if (model.sections.length === 0) return null;
  if (model.delegation !== null) return delegationEntry(model, model.delegation);
  const label = agentsWords(model.total, model.live);
  return {
    label,
    detail: null,
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
