import {
  buildAgentControlProposalCardModel,
  completionReturnPresentation,
  type AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";
import {
  resolveDelegatedTaskStatus,
  summarizeDelegatedTasks,
  type DelegatedTasksSummary,
  type DelegatedTaskTone,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";
import type {
  AgentControlCompletionReturn,
  AgentControlProposalView,
} from "@ryco/contracts/agent-control";

import { formatRelativeTime } from "../../timestampFormat";
import { inboxGlyphLabel } from "../inboxSidebar/inboxRowPresentation";
import {
  resolveInboxThreadStatus,
  type InboxSidebarThreadState,
} from "../inboxSidebar/inboxSidebarModel";

/** A child's colour in the dock: its bar segment and its state text. */
export type DelegationDockTone = DelegatedTaskTone;

export interface DelegationDockResult {
  readonly label: string;
  readonly tone: AgentControlStatusTone;
  /** The server's explanation of where the return stands. */
  readonly detail: string;
  readonly delivered: boolean;
}

export interface DelegationDockChild {
  readonly thread: SidebarThreadSummary;
  readonly state: InboxSidebarThreadState;
  readonly tone: DelegationDockTone;
  /** "Working", "Needs your answer", "Done", "Error"…; the row adds a clock or an age. */
  readonly label: string;
  /** Start of the running turn; background work has none. */
  readonly runningSince: string | null;
  /** When the child last finished a turn. */
  readonly finishedAt: string | null;
  /** Null when the child was created without a result return. */
  readonly result: DelegationDockResult | null;
  /** In error, or its result return is blocked, failed or uncertain (the shared rule). */
  readonly failed: boolean;
}

/** The dock's summary line: the shared counts the phone's agents entry reads too. */
export type DelegationDockSummary = DelegatedTasksSummary;

export interface DelegationDockLogRow {
  readonly proposal: AgentControlProposalView;
  readonly tone: AgentControlStatusTone;
  readonly action: string;
  readonly target: string;
  /** Named only when the action did not simply complete. */
  readonly status: string | null;
  readonly at: string;
}

function resultOf(result: AgentControlCompletionReturn | undefined): DelegationDockResult | null {
  if (result === undefined) return null;
  const presentation = completionReturnPresentation(result.status);
  return {
    label: presentation.label,
    tone: presentation.tone,
    detail: result.detail,
    delivered: result.status === "delivered",
  };
}

export function buildDelegationDockChildren(
  children: ReadonlyArray<SidebarThreadSummary>,
  returnsByChild: ReadonlyMap<ThreadId, AgentControlCompletionReturn>,
): DelegationDockChild[] {
  return children.map((thread) => {
    const status = resolveInboxThreadStatus(thread);
    const completionReturn = returnsByChild.get(thread.id);
    const task = resolveDelegatedTaskStatus({ thread, state: status.state, completionReturn });
    return {
      thread,
      state: status.state,
      tone: task.tone,
      label: task.label ?? inboxGlyphLabel(status, false),
      runningSince: task.runningSince,
      finishedAt: task.finishedAt,
      result: resultOf(completionReturn),
      failed: task.failed,
    };
  });
}

export function summarizeDelegationDock(
  children: ReadonlyArray<DelegationDockChild>,
): DelegationDockSummary {
  return summarizeDelegatedTasks(children);
}

/** The thread's own Agent Control actions, newest first, as one line each. */
export function buildDelegationDockLog(
  activity: ReadonlyArray<AgentControlProposalView>,
  getThreadTitle: (threadId: ThreadId) => string | undefined,
): DelegationDockLogRow[] {
  return activity.map((proposal) => {
    const model = buildAgentControlProposalCardModel(proposal, getThreadTitle);
    return {
      proposal,
      tone: model.statusTone,
      action: model.actionLabel,
      target: model.targetLabel,
      status: model.status === "completed" ? null : model.statusLabel,
      at: proposal.updatedAt,
    };
  });
}

/** "now", "4m ago", "3h ago": a quiet age for finished rows and log lines. */
export function formatDelegationDockAge(isoDate: string, nowMs: number = Date.now()): string {
  const relative = formatRelativeTime(isoDate, nowMs);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : "now";
}
