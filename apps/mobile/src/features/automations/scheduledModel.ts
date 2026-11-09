// The phone's scheduled tasks (automations): every project's schedules on every machine the
// phone reaches, folded into the Tasks tab's "Scheduled" section and the Scheduled screen.
// Rows, words and rules are the web Automations dialog's (`@ryco/client-runtime/state/
// automations/*`); this only decides which checkouts show and in what order. Pure.

import {
  automationCheckoutKey,
  type AutomationCountsEntry,
} from "@ryco/client-runtime/state/automations/projectCounts";
import {
  deriveDialogRows,
  dueDialogRows,
  type DialogCheckoutInput,
  type DialogQueueInput,
  type DialogRow,
  type DueDialogRow,
} from "@ryco/client-runtime/state/automations/dialogModel";
import {
  collectMissedAutomationRuns,
  isSupportedAgentControlProposal,
  scheduleProposalOf,
  scheduleRowPresentation,
  type MissedAutomationRun,
  type ScheduleRowPresentation,
} from "@ryco/client-runtime/state/agentControl";
import type {
  AgentControlProposalId,
  AgentControlProposalView,
  EnvironmentId,
  ProjectId,
} from "@ryco/contracts";

/** A project on a machine whose schedules the phone may read. */
export interface ScheduledCheckoutRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly machineLabel: string;
}

export interface ScheduledCheckout extends DialogCheckoutInput {
  readonly projectName: string;
  readonly machineLabel: string;
}

/** One list row: the shared row, its words and where it lives. */
export interface ScheduledRowModel {
  readonly key: string;
  readonly item: DialogRow;
  readonly presentation: ScheduleRowPresentation;
  /** "Ryco · Mac mini" when several projects or machines show, else null. */
  readonly place: string | null;
}

export interface ScheduledGroup {
  readonly key: string;
  /** The project (and its machine when several machines show). */
  readonly title: string;
  readonly rows: ReadonlyArray<ScheduledRowModel>;
}

export interface ScheduledMissedRuns {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly runs: ReadonlyArray<MissedAutomationRun>;
}

export interface ScheduledList {
  /** Runs waiting for approval, soonest deadline first (they expire in 15 minutes). */
  readonly waiting: ReadonlyArray<DueDialogRow & { readonly place: string | null }>;
  /** Every listed schedule by project; projects with a waiting run or a proposal first. */
  readonly groups: ReadonlyArray<ScheduledGroup>;
  /** The listed schedules, in group order (the Tasks tab previews the first few). */
  readonly rows: ReadonlyArray<ScheduledRowModel>;
  /** Schedule changes waiting for a decision. */
  readonly changes: number;
  /** Catch-up runs of machines that were offline when a schedule came due, per machine. */
  readonly missed: ReadonlyArray<ScheduledMissedRuns>;
  /** Some checkout's schedules have been read. */
  readonly read: boolean;
  /** Checkouts whose read failed (the machine refused it or was unreachable). */
  readonly unavailable: number;
}

export interface ScheduledFilter {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}

const rowUrgency = (row: DialogRow) =>
  row.row.dueRun ? 0 : row.row.proposal || row.row.lapsed ? 1 : row.row.state === "running" ? 2 : 3;

/** The project of an Agent Control proposal about schedules (a change or a run), else null. */
export function automationProposalProjectId(proposal: AgentControlProposalView): ProjectId | null {
  if (!isSupportedAgentControlProposal(proposal)) return null;
  if (proposal.plan.kind === "automationRun") return proposal.plan.execution.projectId;
  return scheduleProposalOf(proposal)?.projectId ?? null;
}

/**
 * The projects whose schedules a queue change concerns: a schedule change or a run that is
 * new or moved since `previous`. Their snapshots are read again.
 */
export function changedAutomationProjects(
  next: Readonly<Record<string, AgentControlProposalView>>,
  previous: Readonly<Record<string, AgentControlProposalView>> | undefined,
): ReadonlySet<ProjectId> {
  const out = new Set<ProjectId>();
  for (const proposal of Object.values(next)) {
    const before = previous?.[proposal.proposalId];
    if (before && before.status === proposal.status && before.updatedAt === proposal.updatedAt)
      continue;
    const projectId = automationProposalProjectId(proposal);
    if (projectId) out.add(projectId);
  }
  return out;
}

/**
 * The phone's Scheduled list from the snapshots read so far (`AutomationCountsEntry`, keyed
 * by `automationCheckoutKey`) and each machine's Agent Control queue.
 */
export function buildScheduledList(input: {
  readonly checkouts: ReadonlyArray<ScheduledCheckoutRef>;
  readonly entries: ReadonlyMap<string, AutomationCountsEntry>;
  readonly queues: ReadonlyMap<EnvironmentId, ReadonlyArray<AgentControlProposalView>>;
  readonly dismissed: ReadonlySet<AgentControlProposalId>;
  readonly filter: ScheduledFilter;
  readonly nowMs: number;
}): ScheduledList {
  const { filter, nowMs } = input;
  const shown = input.checkouts.filter(
    (checkout) =>
      (filter.environmentId === null || checkout.environmentId === filter.environmentId) &&
      (filter.projectId === null || checkout.projectId === filter.projectId),
  );
  const machines = new Set(shown.map((checkout) => checkout.environmentId));
  const severalMachines = machines.size > 1;
  let unavailable = 0;
  let read = false;
  const checkouts: ScheduledCheckout[] = shown.map((checkout) => {
    const key = automationCheckoutKey(checkout.environmentId, checkout.projectId);
    const entry = input.entries.get(key);
    if (entry?.status === "ready") read = true;
    if (entry?.status === "unavailable") unavailable += 1;
    return {
      key,
      environmentId: checkout.environmentId,
      projectId: checkout.projectId,
      deviceLabel: checkout.machineLabel,
      machineLabel: checkout.machineLabel,
      projectName: checkout.projectName,
      snapshot: entry?.status === "ready" ? entry.snapshot : null,
    };
  });
  const queues = new Map<string, DialogQueueInput>();
  for (const checkout of checkouts) {
    queues.set(checkout.key, {
      queueProposals: input.queues.get(checkout.environmentId) ?? [],
      dismissed: input.dismissed,
    });
  }
  const groupsOf = deriveDialogRows(checkouts, queues, nowMs);
  const placeOf = (checkout: ScheduledCheckout) =>
    severalMachines ? `${checkout.projectName} · ${checkout.machineLabel}` : checkout.projectName;
  const severalProjects = checkouts.length > 1;
  const groups: ScheduledGroup[] = groupsOf
    .filter((group) => group.rows.length > 0)
    .map((group) => ({
      key: group.checkout.key,
      title: placeOf(group.checkout),
      rows: group.rows
        .toSorted((a, b) => rowUrgency(a) - rowUrgency(b))
        .map((item) => ({
          key: item.key,
          item,
          presentation: scheduleRowPresentation(item.row, nowMs),
          place: severalProjects ? placeOf(group.checkout) : null,
        })),
    }))
    .toSorted(
      (a, b) =>
        Math.min(...a.rows.map((row) => rowUrgency(row.item))) -
          Math.min(...b.rows.map((row) => rowUrgency(row.item))) || a.title.localeCompare(b.title),
    );
  const placeByKey = new Map(
    groupsOf.flatMap((group) =>
      group.rows.map((row) => [row.key, severalProjects ? placeOf(group.checkout) : null] as const),
    ),
  );
  const allRows = groupsOf.flatMap((group) => group.rows);
  const missed: ScheduledMissedRuns[] = [];
  for (const environmentId of machines) {
    const runs = collectMissedAutomationRuns(input.queues.get(environmentId) ?? [], nowMs).filter(
      (run) =>
        !input.dismissed.has(run.proposalId) &&
        (filter.projectId === null || run.projectId === filter.projectId),
    );
    if (runs.length === 0) continue;
    const label = shown.find((checkout) => checkout.environmentId === environmentId)?.machineLabel;
    missed.push({ environmentId, machineLabel: label ?? "This machine", runs });
  }
  return {
    waiting: dueDialogRows(allRows).map((row) => ({
      ...row,
      place: placeByKey.get(row.key) ?? null,
    })),
    groups,
    rows: groups.flatMap((group) => group.rows),
    changes: allRows.filter((row) => row.row.proposal !== null).length,
    missed,
    read,
    unavailable,
  };
}

/** The Tasks tab's preview: everything urgent, then the soonest few, at most `limit`. */
export function scheduledPreview(
  list: ScheduledList,
  limit: number,
): ReadonlyArray<ScheduledRowModel> {
  const byUrgency = list.rows.toSorted(
    (a, b) =>
      rowUrgency(a.item) - rowUrgency(b.item) ||
      (a.item.row.nextRunAt ?? Number.POSITIVE_INFINITY) -
        (b.item.row.nextRunAt ?? Number.POSITIVE_INFINITY),
  );
  return byUrgency.filter((row) => row.item.row.dueRun === null).slice(0, limit);
}
