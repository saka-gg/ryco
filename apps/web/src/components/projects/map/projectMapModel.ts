/**
 * Converters from Ryco's records into the map's model: the sidebar tree's
 * worktrees and threads, the lifecycle inspection, and the automation
 * centre's schedules and runs. Thread status uses the inbox's own
 * resolution, so a dot on the map means what the same dot means in the inbox;
 * schedule words and run states are the Automations dialog's (the shared
 * schedule model), so a schedule reads the same in both.
 */
import {
  AUTOMATION_RUN_STATUS,
  scheduleRowPresentation,
  type ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";
import type { WorkspaceLifecycleSummary } from "@ryco/contracts";
import { rel, scheduleLabel } from "@ryco/shared/automationSchedule";

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

/**
 * A schedule as the map shows it, from the dialog's own row (the shared
 * schedule model), its runs folded in. Null for a row that is only a
 * proposal (a proposed or expired new schedule): the map draws schedules.
 */
export function toMapAutomation(row: ScheduleRow, nowMs: number): MapAutomation | null {
  const automation = row.automation;
  if (!automation) return null;
  const own = row.runs.toSorted(
    (left, right) => Date.parse(right.run.scheduledFor) - Date.parse(left.run.scheduledFor),
  );
  const pending = own.find(
    (entry) => entry.run.status === "pending-approval" && entry.run.proposalId,
  );
  const running = own.filter(
    (entry) => entry.run.status === "approved" || entry.run.status === "executing",
  );
  const lastSettled = own.find((entry) => !AUTOMATION_RUN_STATUS[entry.run.status].active);
  const { schedule, execution } = automation.definition;
  return {
    id: automation.automationId,
    title: execution.title,
    // Paused is the user's word (the definition); a finished schedule isn't paused.
    enabled: automation.definition.enabled && !automation.cancelled,
    // What the dialog's row says when there is no next run to count down to.
    stateLabel: scheduleRowPresentation(row, nowMs).meta,
    // "Every 2 h · until Oct 31" · "Once · today 16:00", as the dialog says it.
    scheduleLabel: scheduleLabel(schedule, nowMs),
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

/**
 * "in 7m" · "in 3h 20m" · "tomorrow" · "in 4 days" — the dialog's words;
 * without a next run, the dialog's word for the schedule's state ("Paused"
 * only when it is paused; "Finished", "Waiting for approval", "Starting").
 */
export function nextRunLabel(
  automation: Pick<MapAutomation, "nextRunAt" | "stateLabel">,
  nowMs: number,
): string {
  if (!automation.nextRunAt) return automation.stateLabel;
  return rel(automation.nextRunAt, nowMs);
}
