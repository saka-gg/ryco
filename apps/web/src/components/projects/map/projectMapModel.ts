/**
 * Converters from Ryco's records into the map's model: the sidebar tree's
 * worktrees and threads, the lifecycle inspection, and the automation
 * centre's schedules and runs. Thread status uses the inbox's own
 * resolution, so a dot on the map means what the same dot means in the inbox.
 */
import type {
  AgentControlAutomation,
  AgentControlAutomationSchedule,
  AgentControlProposal,
  AgentControlProposalId,
  AutomationCentreRun,
  WorkspaceLifecycleSummary,
} from "@ryco/contracts";

import { inboxGlyphLabel, resolveInboxGlyph } from "../../inboxSidebar/inboxRowPresentation";
import { resolveInboxThreadStatus } from "../../inboxSidebar/inboxSidebarModel";
import type { SidebarTreeThread, SidebarTreeWorktree } from "../../sidebar/hooks/useSidebarTree";
import {
  findWorkspaceSummary,
  workspaceFacts,
  type WorkspaceFact,
} from "../sections/projectWorkspaces.logic";
import type {
  MapAutomation,
  MapThread,
  MapWorkspace,
  MapWorkspaceOrigin,
} from "./projectMap.logic";

export function toMapThread(thread: SidebarTreeThread, archived: boolean): MapThread {
  const status = resolveInboxThreadStatus(thread);
  const glyph = resolveInboxGlyph(status, false);
  return {
    id: thread.id,
    title: thread.title,
    glyph,
    glyphLabel: archived ? "Archived" : inboxGlyphLabel(status, false),
    archived,
    activityAt: thread.updatedAt ?? thread.createdAt ?? null,
  };
}

function originOf(node: SidebarTreeWorktree): MapWorkspaceOrigin {
  const { worktree } = node;
  if (worktree.origin === "pr" && worktree.prNumber)
    return {
      kind: "pr",
      number: worktree.prNumber,
      state: worktree.prState ?? null,
      isDraft: worktree.prIsDraft === true,
    };
  if (worktree.origin === "issue" && worktree.issueNumber)
    return { kind: "issue", number: worktree.issueNumber };
  if (worktree.workItemKey) return { kind: "work-item", key: worktree.workItemKey };
  return null;
}

/** A tree worktree, with what the server's inspection found about it. */
export function toMapWorkspace(
  node: SidebarTreeWorktree,
  summaries: readonly WorkspaceLifecycleSummary[],
  archived: boolean,
): { readonly workspace: MapWorkspace; readonly summary: WorkspaceLifecycleSummary | null } {
  const main = node.worktree.origin === "main";
  const summary = findWorkspaceSummary(summaries, { worktreeId: node.worktree.worktreeId, main });
  const checkoutRemoved =
    node.worktree.checkoutRemovedAt != null || summary?.checkout === "removed";
  /* Without an inspection, a removed checkout is still worth saying. */
  const facts: WorkspaceFact[] = summary
    ? workspaceFacts(summary)
    : checkoutRemoved
      ? [{ label: "Checkout removed", tone: "muted" }]
      : [];
  return {
    summary,
    workspace: {
      id: node.worktree.worktreeId,
      registeredId: summary?.worktreeId ?? null,
      title: main ? null : (node.worktree.title ?? null),
      branch: node.worktree.branch,
      main,
      archived,
      checkoutRemoved,
      origin: originOf(node),
      facts,
      threads: [
        ...node.sessions.map((thread) => toMapThread(thread, false)),
        ...node.archivedSessions.map((thread) => toMapThread(thread, true)),
      ],
    },
  };
}

/** A registered workspace the sidebar's tree does not list (no threads known). */
export function summaryOnlyWorkspace(summary: WorkspaceLifecycleSummary): MapWorkspace {
  return {
    id: summary.worktreeId,
    registeredId: summary.worktreeId,
    title: summary.title !== summary.branch ? summary.title : null,
    branch: summary.branch,
    main: summary.main,
    archived: summary.archivedAt !== null,
    checkoutRemoved: summary.checkout === "removed",
    origin: null,
    facts: workspaceFacts(summary),
    threads: [],
  };
}

const DAY = 24 * 60 * 60_000;
const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const formatMoment = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** "Every 30 min · until Oct 31", "Daily · until Dec 31", "Once · Oct 9, 10:00". */
export function automationScheduleLabel(schedule: AgentControlAutomationSchedule): string {
  if (schedule.kind === "once") return `Once · ${formatMoment(schedule.runAt)}`;
  const ms = schedule.intervalMs;
  const every =
    ms % (7 * DAY) === 0
      ? ms === 7 * DAY
        ? "Weekly"
        : `Every ${ms / (7 * DAY)} weeks`
      : ms % DAY === 0
        ? ms === DAY
          ? "Daily"
          : `Every ${ms / DAY} days`
        : ms % 3_600_000 === 0
          ? ms === 3_600_000
            ? "Hourly"
            : `Every ${ms / 3_600_000} h`
          : `Every ${Math.max(1, Math.round(ms / 60_000))} min`;
  return `${every} · until ${formatDay(schedule.endsAt)}`;
}

const ACTIVE_RUN = new Set(["materializing", "pending-approval", "approved", "executing"]);

/** A schedule as the map shows it, with its runs folded in. */
export function toMapAutomation(
  automation: AgentControlAutomation,
  runs: readonly AutomationCentreRun[],
): MapAutomation {
  const own = runs
    .filter((entry) => entry.run.automationId === automation.automationId)
    .toSorted(
      (left, right) => Date.parse(right.run.scheduledFor) - Date.parse(left.run.scheduledFor),
    );
  const pending = own.find(
    (entry) => entry.run.status === "pending-approval" && entry.run.proposalId,
  );
  const running = own.filter(
    (entry) => entry.run.status === "approved" || entry.run.status === "executing",
  );
  const lastSettled = own.find((entry) => !ACTIVE_RUN.has(entry.run.status));
  const { schedule, execution } = automation.definition;
  return {
    id: automation.automationId,
    title: execution.title,
    enabled: automation.enabled && !automation.cancelled,
    scheduleLabel: automationScheduleLabel(schedule),
    nextRunAt: automation.enabled && !automation.cancelled ? automation.nextRunAt : null,
    intervalMs: schedule.kind === "fixed-interval" ? schedule.intervalMs : null,
    envMode: execution.envMode,
    pendingProposalId: pending?.run.proposalId ?? null,
    running: running.length > 0,
    lastRunFailed: lastSettled?.run.status === "failed",
    threadIds: own.flatMap((entry) => entry.threadIds),
    runningThreadIds: running.flatMap((entry) => entry.threadIds),
  };
}

/** "in 7m", "in 3h 20m", "in 3d", "due now". */
export function nextRunLabel(nextRunAt: string | null, nowMs: number): string {
  if (!nextRunAt) return "Paused";
  const minutes = Math.round((Date.parse(nextRunAt) - nowMs) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  return `in ${Math.round(minutes / (24 * 60))}d`;
}

/** A schedule change someone asked for that waits for approval. */
export interface PendingScheduleChange {
  readonly proposalId: AgentControlProposalId;
  /** The schedule it changes; null for a new one. */
  readonly automationId: string | null;
  /** "Pause", "Resume", "Update", "Cancel schedule", "New schedule". */
  readonly label: string;
  /** The schedule's title as the change leaves it. */
  readonly title: string;
}

/** Saving or cancelling a schedule creates a proposal; these are the open ones. */
export function pendingScheduleChanges(
  proposals: readonly AgentControlProposal[],
): PendingScheduleChange[] {
  return proposals.flatMap((proposal): PendingScheduleChange[] => {
    if (proposal.status !== "pending-user-approval") return [];
    const { plan } = proposal;
    switch (plan.kind) {
      case "createAutomation":
        return [
          {
            proposalId: proposal.proposalId,
            automationId: null,
            label: "New schedule",
            title: plan.definition.execution.title,
          },
        ];
      case "updateAutomation": {
        const before = plan.before.definition;
        const onlyToggled =
          before.enabled !== plan.after.enabled &&
          JSON.stringify({ ...before, enabled: plan.after.enabled }) === JSON.stringify(plan.after);
        return [
          {
            proposalId: proposal.proposalId,
            automationId: plan.automationId,
            label: onlyToggled ? (plan.after.enabled ? "Resume" : "Pause") : "Update",
            title: plan.after.execution.title,
          },
        ];
      }
      case "cancelAutomation":
        return [
          {
            proposalId: proposal.proposalId,
            automationId: plan.automationId,
            label: "Cancel schedule",
            title: plan.expected.definition.execution.title,
          },
        ];
      default:
        return [];
    }
  });
}
