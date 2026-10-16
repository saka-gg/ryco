import {
  buildAgentControlProposalCardModel,
  completionReturnPresentation,
  type AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";
import type {
  AgentControlCompletionReturn,
  AgentControlProposal,
} from "@ryco/contracts/agent-control";

import { formatRelativeTime } from "../../timestampFormat";
import { inboxGlyphLabel } from "../inboxSidebar/inboxRowPresentation";
import {
  resolveInboxThreadStatus,
  resolveRunningSince,
  type InboxSidebarThreadState,
} from "../inboxSidebar/inboxSidebarModel";

/** A child's colour in the dock: its bar segment and its state text. */
export type DelegationDockTone = "working" | "attention" | "done" | "danger" | "muted";

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
}

export interface DelegationDockSummary {
  readonly working: number;
  readonly needsYou: number;
  /** Children in error, or whose result return is blocked, failed or uncertain. */
  readonly failed: number;
  readonly returned: number;
  /** Children whose result returns here; "N of M returned" counts only these. */
  readonly returning: number;
}

export interface DelegationDockLogRow {
  readonly proposal: AgentControlProposal;
  readonly tone: AgentControlStatusTone;
  readonly action: string;
  readonly target: string;
  /** Named only when the action did not simply complete. */
  readonly status: string | null;
  readonly at: string;
}

function toneOf(state: InboxSidebarThreadState): DelegationDockTone {
  switch (state) {
    case "working":
      return "working";
    case "needs-input":
    case "limited":
      return "attention";
    case "error":
    case "delivery-unknown":
      return "danger";
    case "idle":
      return "done";
    case "connecting":
    case "reconnecting":
    case "offline":
      return "muted";
  }
}

function labelOf(
  status: ReturnType<typeof resolveInboxThreadStatus>,
  finishedAt: string | null,
): string {
  if (status.state === "working") return "Working";
  if (status.state === "idle") return finishedAt ? "Done" : "Idle";
  return inboxGlyphLabel(status, false);
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
    const finishedAt = thread.latestCompletedTurnAt ?? thread.latestTurn?.completedAt ?? null;
    return {
      thread,
      state: status.state,
      tone: status.state === "idle" && !finishedAt ? "muted" : toneOf(status.state),
      label: labelOf(status, finishedAt),
      runningSince: status.state === "working" ? resolveRunningSince(thread) : null,
      finishedAt,
      result: resultOf(returnsByChild.get(thread.id)),
    };
  });
}

export function summarizeDelegationDock(
  children: ReadonlyArray<DelegationDockChild>,
): DelegationDockSummary {
  let working = 0;
  let needsYou = 0;
  let failed = 0;
  let returned = 0;
  let returning = 0;
  for (const child of children) {
    if (child.state === "working") working += 1;
    if (child.state === "needs-input") needsYou += 1;
    if (child.tone === "danger" || child.result?.tone === "danger") failed += 1;
    if (child.result !== null) returning += 1;
    if (child.result?.delivered) returned += 1;
  }
  return { working, needsYou, failed, returned, returning };
}

/** The thread's own Agent Control actions, newest first, as one line each. */
export function buildDelegationDockLog(
  activity: ReadonlyArray<AgentControlProposal>,
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
