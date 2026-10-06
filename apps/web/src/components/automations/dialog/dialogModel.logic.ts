/**
 * The Automations dialog's view model, pure: a project's checkouts (one per
 * device) folded into the lab's list (device groups of rows), its selection
 * fallback, the header's queue line and the active-schedule limit.
 *
 * Rows come from the shared model (`deriveScheduleRows`); nothing here does
 * schedule math of its own.
 */
import type {
  AgentControlAutomationId,
  AgentControlProposal,
  AgentControlProposalId,
  AutomationCentreSnapshot,
  EnvironmentId,
  ProjectId,
} from "@ryco/contracts";
import {
  activeScheduleCount,
  deriveScheduleRows,
  scheduleProposalFailure,
  type ScheduleDueRun,
  type ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";
import { AUTOMATION_LIMITS } from "@ryco/shared/automationSchedule";

/** What the model needs of a checkout (`ProjectAutomationsCheckout` fits). */
export interface DialogCheckoutInput {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly deviceLabel: string;
  readonly snapshot: AutomationCentreSnapshot | null;
}

/** What the model needs of a checkout's device queue (`CheckoutProposalQueue` fits). */
export interface DialogQueueInput {
  readonly queueProposals: readonly AgentControlProposal[];
  readonly dismissed: ReadonlySet<AgentControlProposalId>;
}

/** One schedule row, placed on its device. */
export interface DialogRow {
  /** Unique in the dialog: the device and the schedule. */
  readonly key: string;
  readonly checkoutKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly row: ScheduleRow;
}

/** A device's share of the list. */
export interface DialogCheckoutRows<C extends DialogCheckoutInput = DialogCheckoutInput> {
  readonly checkout: C;
  /** The checkout's rows as the shared model sorts them (new ones first, then by title). */
  readonly rows: readonly DialogRow[];
  /** The same rows unwrapped, for the shared model's per-checkout rules (retry). */
  readonly scheduleRows: readonly ScheduleRow[];
}

export function dialogRowKey(
  environmentId: EnvironmentId,
  automationId: AgentControlAutomationId,
): string {
  // A unit separator: never in an id, and harmless in a DOM attribute.
  return `${environmentId}\u001f${automationId}`;
}

/** Every checkout's rows, in the project's device order (this device first). */
export function deriveDialogRows<C extends DialogCheckoutInput>(
  checkouts: readonly C[],
  queues: ReadonlyMap<string, DialogQueueInput>,
  nowMs: number,
): DialogCheckoutRows<C>[] {
  return checkouts.map((checkout) => {
    if (!checkout.snapshot) return { checkout, rows: [], scheduleRows: [] };
    const queue = queues.get(checkout.key);
    const scheduleRows = deriveScheduleRows({
      projectId: checkout.projectId,
      snapshot: checkout.snapshot,
      ...(queue ? { queueProposals: queue.queueProposals, dismissedLapsed: queue.dismissed } : {}),
      nowMs,
    });
    return {
      checkout,
      scheduleRows,
      rows: scheduleRows.map((row) => ({
        key: dialogRowKey(checkout.environmentId, row.id),
        checkoutKey: checkout.key,
        environmentId: checkout.environmentId,
        projectId: checkout.projectId,
        row,
      })),
    };
  });
}

export function flattenDialogRows(groups: readonly DialogCheckoutRows[]): DialogRow[] {
  return groups.flatMap((group) => group.rows);
}

/** One device's part of the list. */
export interface DialogListSection {
  readonly key: string;
  /**
   * The device it names (a heading, and a group around its rows), or null on
   * a project that lives on one device: its rows stand alone.
   */
  readonly checkoutKey: string | null;
  readonly rows: readonly DialogRow[];
}

/**
 * The list: each device's rows under its heading when the project lives on
 * more than one device; devices without schedules get no heading.
 */
export function dialogListSections(groups: readonly DialogCheckoutRows[]): DialogListSection[] {
  const grouped = groups.length > 1;
  return groups
    .filter((group) => group.rows.length > 0)
    .map((group) => ({
      key: `g:${group.checkout.key}`,
      checkoutKey: grouped ? group.checkout.key : null,
      rows: group.rows,
    }));
}

export type DueDialogRow = DialogRow & { readonly due: ScheduleDueRun };

/** The runs waiting for approval, soonest deadline first. */
export function dueDialogRows(rows: readonly DialogRow[]): DueDialogRow[] {
  return rows
    .flatMap((item) => (item.row.dueRun ? [{ ...item, due: item.row.dueRun }] : []))
    .toSorted((a, b) => a.due.expiresAtMs - b.due.expiresAtMs);
}

/**
 * The selected row: the one chosen while it still exists, else the schedule
 * whose waiting run expires first, else the first row.
 */
export function resolveDialogSelection(
  rows: readonly DialogRow[],
  stored: string | null,
): string | null {
  if (stored && rows.some((item) => item.key === stored)) return stored;
  const due = dueDialogRows(rows)[0];
  return due?.key ?? rows[0]?.key ?? null;
}

/**
 * The header's one line of what waits: runs (time-boxed) and schedule
 * changes (no deadline). The selected schedule is left out — its detail owns
 * that run or change. While editing, nothing is selected.
 */
export interface DialogQueueLine {
  readonly runs: {
    readonly count: number;
    readonly first: DueDialogRow;
    readonly title: string;
    readonly expiresAtMs: number;
  } | null;
  readonly changes: { readonly count: number; readonly first: DialogRow } | null;
}

export function dialogQueueLine(
  rows: readonly DialogRow[],
  selectedKey: string | null,
): DialogQueueLine {
  const runs = dueDialogRows(rows).filter((item) => item.key !== selectedKey);
  const changes = rows
    .filter((item) => item.row.proposal !== null && item.key !== selectedKey)
    .toSorted(
      (a, b) =>
        (a.row.proposal?.createdAt ?? "").localeCompare(b.row.proposal?.createdAt ?? "") ||
        a.key.localeCompare(b.key),
    );
  const firstRun = runs[0];
  const firstChange = changes[0];
  return {
    runs: firstRun
      ? {
          count: runs.length,
          first: firstRun,
          title: firstRun.row.title || "Untitled schedule",
          expiresAtMs: firstRun.due.expiresAtMs,
        }
      : null,
    changes: firstChange ? { count: changes.length, first: firstChange } : null,
  };
}

/**
 * The active-schedule limit, which the backend applies per checkout. The
 * header says it once, for the fullest device; "New" is off only when no
 * device can take another schedule. Only devices whose schedules were read
 * count: one still loading or out of reach can't be shown to have room, and
 * a schedule proposed there would not save.
 */
export interface DialogLimit {
  /** Active schedules on the fullest device. */
  readonly active: number;
  readonly perProject: number;
  /** The fullest device's checkout, or null without a read device. */
  readonly checkoutKey: string | null;
  readonly deviceLabel: string | null;
  /** The cap is said once it is within five of the limit. */
  readonly show: boolean;
  /** The fullest device is at the limit. */
  readonly full: boolean;
  /** Every read device is at the limit: nothing new can be added. */
  readonly allFull: boolean;
  /** Read checkouts that can still take a schedule, in device order. */
  readonly openCheckoutKeys: readonly string[];
  /** Checkouts whose schedules were read (so their count is known), in device order. */
  readonly readableCheckoutKeys: readonly string[];
}

export function dialogLimit(checkouts: readonly DialogCheckoutInput[]): DialogLimit {
  const perProject = AUTOMATION_LIMITS.perProject;
  let fullest: { key: string; label: string; active: number } | null = null;
  const open: string[] = [];
  const readable: string[] = [];
  for (const checkout of checkouts) {
    if (!checkout.snapshot) continue;
    readable.push(checkout.key);
    const active = activeScheduleCount(checkout.snapshot);
    if (active < perProject) open.push(checkout.key);
    if (!fullest || active > fullest.active)
      fullest = { key: checkout.key, label: checkout.deviceLabel, active };
  }
  const active = fullest?.active ?? 0;
  return {
    active,
    perProject,
    checkoutKey: fullest?.key ?? null,
    deviceLabel: fullest?.label ?? null,
    show: readable.length > 0 && active >= perProject - 5,
    full: active >= perProject,
    allFull: readable.length > 0 && open.length === 0,
    openCheckoutKeys: open,
    readableCheckoutKeys: readable,
  };
}

/**
 * The device a new schedule starts on. One asked for (a device's own "New
 * schedule") is kept whenever it can be read, even at the limit — the editor
 * then says why Save is off, rather than the draft moving to another device
 * unasked. Otherwise the first device with room (this device first), else
 * none.
 */
export function newScheduleCheckout(
  limit: DialogLimit,
  requestedKey: string | null,
): string | null {
  if (requestedKey && limit.readableCheckoutKeys.includes(requestedKey)) return requestedKey;
  return limit.openCheckoutKeys[0] ?? null;
}

/** The current project's switcher counts, read off its live rows (lapsed ones aside). */
export function liveProjectCounts(rows: readonly DialogRow[]): {
  readonly schedules: number;
  readonly waiting: number;
} {
  const listed = rows.filter((item) => item.row.state !== "lapsed");
  return {
    schedules: listed.length,
    waiting: listed.filter((item) => item.row.dueRun !== null).length,
  };
}

/** What an open request (`openAutomationsDialog`) asks of the rows. */
export interface DialogRequestInput {
  readonly automationId: string | null;
  readonly mode: "view" | "edit" | "new";
  /** For a checkout-named request: only that device's schedule matches. */
  readonly environmentId: EnvironmentId | null;
}

export type DialogRequestOutcome =
  /** The rows (or the limit) aren't known yet. */
  | { readonly kind: "wait" }
  /** Nothing to do (no schedule named, or it isn't there). */
  | { readonly kind: "drop" }
  | { readonly kind: "select"; readonly item: DialogRow; readonly edit: boolean }
  | { readonly kind: "new" };

/**
 * Where a request lands once the project's rows are known: its schedule
 * selected (and, for "edit", its editor open unless it lapsed), or a new
 * draft once the limit is known.
 */
export function resolveDialogRequest(input: {
  readonly request: DialogRequestInput;
  readonly rows: readonly DialogRow[];
  readonly loading: boolean;
}): DialogRequestOutcome {
  const { request, rows, loading } = input;
  if (request.mode === "new") return loading ? { kind: "wait" } : { kind: "new" };
  if (!request.automationId) return { kind: "drop" };
  const item = rows.find(
    (candidate) =>
      candidate.row.id === request.automationId &&
      (request.environmentId === null || candidate.environmentId === request.environmentId),
  );
  if (!item) return loading ? { kind: "wait" } : { kind: "drop" };
  return { kind: "select", item, edit: request.mode === "edit" && item.row.state !== "lapsed" };
}

/** What an approval was for: a waiting run, or a proposed change to a schedule. */
export type ApprovalKind = "run" | "change";

export type ApprovalOutcome =
  /** Not settled yet (still waiting, or a change still being applied). */
  | { readonly kind: "pending" }
  /** Went through, or ended in a way the dialog already shows. */
  | { readonly kind: "settled" }
  /** Didn't go through: say so (the lab's notices). */
  | { readonly kind: "notice"; readonly tone: "warning" | "error"; readonly title: string };

/**
 * What became of an approval, read off the device's Agent Control queue (the
 * proposal's status there): a run whose approval lapsed before it got
 * through ("That approval expired before it went through."), a change that
 * couldn't be applied (its error, else "The change couldn't be applied.").
 * Anything else the dialog already shows: a dispatched run in its history, a
 * change as the schedule, an expired change as "Proposal expired".
 */
export function approvalOutcome(
  proposal: AgentControlProposal | undefined,
  kind: ApprovalKind,
): ApprovalOutcome {
  if (!proposal || proposal.status === "pending-user-approval") return { kind: "pending" };
  if (kind === "run")
    return proposal.status === "expired"
      ? { kind: "notice", tone: "warning", title: "That approval expired before it went through." }
      : { kind: "settled" };
  if (proposal.status === "approved" || proposal.status === "executing") return { kind: "pending" };
  if (proposal.status !== "failed") return { kind: "settled" };
  return {
    kind: "notice",
    tone: "error",
    title: scheduleProposalFailure(proposal) ?? "The change couldn't be applied.",
  };
}
