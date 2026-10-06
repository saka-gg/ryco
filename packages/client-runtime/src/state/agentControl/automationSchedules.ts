/**
 * The Automations dialog's model: one checkout's schedules as rows.
 *
 * Built from the automation centre snapshot (automations, runs, the *active*
 * proposals) and the Agent Control queue store's proposals (which keep
 * terminal ones as recent history — that is where an expired, undecided
 * schedule proposal is still visible). Pure: the dialog derives rows on each
 * snapshot, queue change or clock minute and patches its list by row id.
 *
 * Vocabulary is the dialog's: runs are "waiting for approval", schedule
 * changes are "proposed", "Dispatched" never means done. Retry rules mirror
 * the server's `AutomationCentre` command; schedule rules live in
 * `@ryco/shared/automationSchedule`.
 */
import {
  AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
  type AgentControlAutomation,
  type AgentControlAutomationDefinition,
  type AgentControlAutomationExecutionTemplate,
  type AgentControlAutomationId,
  type AgentControlAutomationRunStatus,
  type AgentControlAutomationSchedule,
  type AgentControlProposal,
  type AgentControlProposalId,
  type AgentControlProposalStatus,
  type AgentTokenMode,
  type AutomationCentreRun,
  type AutomationCentreSnapshot,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ThreadEnvMode,
} from "@ryco/contracts";
import {
  AUTOMATION_LIMITS,
  DAY_MS,
  MINUTE_MS,
  addDays,
  cadence,
  ceilQuarter,
  everyWords,
  firstRun,
  floorMinute,
  formatDate,
  isoFromMs,
  nextRun,
  rollForward,
  scheduleLabel,
  scheduleToContract,
  scheduleToMs,
  toMs,
  validateScheduleDefinition,
  when,
  type AutomationProviderInfo,
  type ScheduleErrors,
  type ScheduleMs,
} from "@ryco/shared/automationSchedule";
import { getModelDisplayName, sameModelSelection } from "@ryco/shared/model";

// ── Run status ───────────────────────────────────────────────────────

/**
 * One hue, and only for what went wrong. "wait" hollow ring (waiting for
 * approval), "fg" filled neutral (approved, starting, dispatched — never a
 * success colour), "err" red (failed), "zinc" filled faint (preparing),
 * "faint" hollow faint (rejected, expired, cancelled).
 */
export type AutomationRunTone = "wait" | "fg" | "err" | "zinc" | "faint";

export interface AutomationRunStatusPresentation {
  readonly label: string;
  readonly tone: AutomationRunTone;
  /** Still in flight: waiting, preparing or starting. */
  readonly active: boolean;
}

export const AUTOMATION_RUN_STATUS: Readonly<
  Record<AgentControlAutomationRunStatus, AutomationRunStatusPresentation>
> = {
  materializing: { label: "Preparing", tone: "zinc", active: true },
  "pending-approval": { label: "Waiting for approval", tone: "wait", active: true },
  approved: { label: "Approved", tone: "fg", active: true },
  executing: { label: "Starting", tone: "fg", active: true },
  completed: { label: "Dispatched", tone: "fg", active: false },
  failed: { label: "Failed", tone: "err", active: false },
  rejected: { label: "Rejected", tone: "faint", active: false },
  expired: { label: "Expired", tone: "faint", active: false },
  cancelled: { label: "Cancelled", tone: "faint", active: false },
};

/** Runs past approval whose thread is being started (the schedule reads "Starting"). */
const STARTING_RUN_STATUSES: ReadonlySet<AgentControlAutomationRunStatus> = new Set([
  "materializing",
  "approved",
  "executing",
]);
const RETRYABLE_RUN_STATUSES: ReadonlySet<AgentControlAutomationRunStatus> = new Set([
  "rejected",
  "expired",
  "cancelled",
]);

const isActiveRun = (entry: AutomationCentreRun) => AUTOMATION_RUN_STATUS[entry.run.status].active;

// ── Rows ─────────────────────────────────────────────────────────────

export type ScheduleRowState =
  | "awaiting-approval"
  | "running"
  | "paused"
  | "finished"
  | "pending-create"
  | "lapsed"
  | "scheduled";

export type ScheduleProposalKind = "create" | "edit" | "pause" | "resume" | "cancel";

/** "Waiting for approval" is reserved for runs; schedule changes are "proposed". */
export const SCHEDULE_PROPOSAL_TAG: Readonly<
  Record<Exclude<ScheduleProposalKind, "create">, string>
> = {
  edit: "Change proposed",
  pause: "Pause proposed",
  resume: "Resume proposed",
  cancel: "Cancel proposed",
};
export const SCHEDULE_LAPSED_TAG: Readonly<
  Record<Exclude<ScheduleProposalKind, "create">, string>
> = {
  edit: "Change expired",
  pause: "Pause expired",
  resume: "Resume expired",
  cancel: "Cancel expired",
};

/** A schedule change waiting for (or past) the user's decision. */
export interface ScheduleProposal {
  readonly id: AgentControlProposalId;
  readonly kind: ScheduleProposalKind;
  readonly automationId: AgentControlAutomationId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The definition it changes (null for a create). */
  readonly before: AgentControlAutomationDefinition | null;
  /** The definition it proposes (null for a cancel). */
  readonly after: AgentControlAutomationDefinition | null;
  /** The revision it was proposed against (null for a create). */
  readonly expectedRevision: number | null;
  readonly status: AgentControlProposalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** `expiresAt` in epoch ms. */
  readonly expiresAtMs: number;
  /**
   * Why an approved change was not applied (status "failed"), in the
   * dialog's words; null otherwise.
   */
  readonly failure: string | null;
  readonly proposal: AgentControlProposal;
}

export interface ScheduleDueRun {
  readonly entry: AutomationCentreRun;
  /** Approve / Reject = decide this proposal. */
  readonly proposalId: AgentControlProposalId | null;
  /** The approval deadline (the run's proposal; else its 15-minute window). */
  readonly expiresAt: string;
  /** `expiresAt` in epoch ms. */
  readonly expiresAtMs: number;
  readonly scheduledFor: string;
  /** `scheduledFor` in epoch ms. */
  readonly scheduledForMs: number;
  /** Missed occurrences folded into this one approval (0 = on time). */
  readonly coalescedOccurrences: number;
}

export interface ScheduleRow {
  readonly id: AgentControlAutomationId;
  readonly automation: AgentControlAutomation | null;
  /** The pending change (create, edit, pause, resume, cancel), newest first. */
  readonly proposal: ScheduleProposal | null;
  /** A change that expired undecided (only when nothing is pending). */
  readonly lapsed: ScheduleProposal | null;
  /** What the row describes: the schedule, or the proposed one for a create. */
  readonly def: AgentControlAutomationDefinition;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly state: ScheduleRowState;
  /** Epoch ms of the next due run (the first run for a pending create). */
  readonly nextRunAt: number | null;
  readonly dueRun: ScheduleDueRun | null;
  /** A run being prepared or started (materializing, approved, executing). */
  readonly activeRun: AutomationCentreRun | null;
  /** The newest finished run. */
  readonly lastRun: AutomationCentreRun | null;
  /** Every run of the schedule, newest first. */
  readonly runs: ReadonlyArray<AutomationCentreRun>;
  /** Finished runs, newest first (the detail's history). */
  readonly history: ReadonlyArray<AutomationCentreRun>;
}

/**
 * Paused by the user: the definition is disabled. The stored `enabled` flag is
 * not the user's word — the server also turns it off when a schedule's last
 * run has come due, and that schedule is finished, not paused.
 */
export function isSchedulePaused(automation: AgentControlAutomation | null | undefined): boolean {
  return !!automation && !automation.cancelled && !automation.definition.enabled;
}

export function isScheduleActive(automation: AgentControlAutomation | null | undefined): boolean {
  return (
    !!automation && automation.enabled && !automation.cancelled && automation.nextRunAt !== null
  );
}

/** Active schedules in a checkout — the 25-per-project limit counts these. */
export function activeScheduleCount(snapshot: AutomationCentreSnapshot | null | undefined): number {
  return snapshot ? snapshot.automations.filter(isScheduleActive).length : 0;
}

// ── Proposals ────────────────────────────────────────────────────────

const sameExecution = (
  a: AgentControlAutomationExecutionTemplate,
  b: AgentControlAutomationExecutionTemplate,
) =>
  a.projectId === b.projectId &&
  a.title === b.title &&
  a.prompt === b.prompt &&
  a.runtimeMode === b.runtimeMode &&
  a.envMode === b.envMode &&
  (a.baseRef ?? null) === (b.baseRef ?? null) &&
  (a.tokenMode ?? null) === (b.tokenMode ?? null) &&
  sameModelSelection(a.modelSelection, b.modelSelection);

/* The same schedule, allowing a start rolled forward to a later occurrence
   (a pause or resume moves a past start to the next run). */
const samePhase = (a: AgentControlAutomationSchedule, b: AgentControlAutomationSchedule) => {
  const x = scheduleToMs(a);
  const y = scheduleToMs(b);
  if (x.kind === "once" || y.kind === "once")
    return x.kind === y.kind && firstRun(x) === firstRun(y);
  return (
    x.intervalMs === y.intervalMs &&
    x.endsAt === y.endsAt &&
    (y.startsAt - x.startsAt) % x.intervalMs === 0
  );
};

/** Pause / resume when only `enabled` flipped (start possibly rolled forward), else edit. */
export function updateProposalKind(
  before: AgentControlAutomationDefinition,
  after: AgentControlAutomationDefinition,
): "edit" | "pause" | "resume" {
  if (
    before.enabled !== after.enabled &&
    sameExecution(before.execution, after.execution) &&
    samePhase(before.schedule, after.schedule)
  )
    return after.enabled ? "resume" : "pause";
  return "edit";
}

const FAILED = "The change couldn't be applied.";

/* The server's lifecycle refusals ("Agent Control plan validation failed
   (reason): detail") in the dialog's words, by reason, then by detail. */
const VALIDATION_FAILURE = /^Agent Control plan validation failed \(([a-z-]+)\): ([\s\S]*)$/;

function failureWords(reason: string, detail: string): string | null {
  switch (reason) {
    case "schedule-invalid":
      // The horizon only grows, so an end check failing at apply time means
      // the end fell before the first run.
      return /first scheduled run/i.test(detail)
        ? "The first run time passed before approval. Edit the start and save again."
        : "The schedule no longer fits the limits. Edit it and save again.";
    case "automation-limit":
      return `This project already has ${AUTOMATION_LIMITS.perProject} active schedules.`;
    case "automation-stale":
      if (/already exists/i.test(detail)) return "A schedule with this id already exists.";
      if (/cancelled/i.test(detail)) return "Cancelled schedules can't be changed.";
      return "The schedule changed since this was proposed. Review it again.";
    case "automation-unavailable":
      return /^Automation is unavailable/i.test(detail)
        ? "This schedule no longer exists."
        : "Schedules aren't available on this device right now.";
    case "provider-unavailable":
    case "model-unavailable":
    case "invalid-options":
      return "The model isn't available on this device any more. Edit the model and save again.";
    case "worktree-preflight":
      return "The branch isn't available any more. Pick another and save again.";
    default:
      return null;
  }
}

/**
 * Why an approved schedule change failed to apply, in the dialog's words
 * (the lab's "The first run time passed before approval…"), else the
 * server's own detail; null unless the proposal failed.
 */
export function scheduleProposalFailure(proposal: AgentControlProposal): string | null {
  if (proposal.status !== "failed") return null;
  const result = proposal.result;
  const message = result?.outcome === "failed" ? result.error.message.trim() : "";
  const match = VALIDATION_FAILURE.exec(message);
  if (!match) return message || FAILED;
  const detail = match[2]?.trim() ?? "";
  return failureWords(match[1] ?? "", detail) ?? (detail || FAILED);
}

/** A schedule proposal's reading, or null for any other Agent Control proposal. */
export function scheduleProposalOf(proposal: AgentControlProposal): ScheduleProposal | null {
  const base = {
    id: proposal.proposalId,
    status: proposal.status,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    expiresAtMs: toMs(proposal.expiresAt),
    failure: scheduleProposalFailure(proposal),
    proposal,
  };
  const plan = proposal.plan;
  switch (plan.kind) {
    case "createAutomation":
      return {
        ...base,
        kind: "create",
        automationId: plan.automationId,
        projectId: plan.definition.execution.projectId,
        title: plan.definition.execution.title,
        before: null,
        after: plan.definition,
        expectedRevision: null,
      };
    case "updateAutomation":
      return {
        ...base,
        kind: updateProposalKind(plan.before.definition, plan.after),
        automationId: plan.automationId,
        projectId: plan.after.execution.projectId,
        title: plan.after.execution.title,
        before: plan.before.definition,
        after: plan.after,
        expectedRevision: plan.before.revision,
      };
    case "cancelAutomation":
      return {
        ...base,
        kind: "cancel",
        automationId: plan.automationId,
        projectId: plan.expected.definition.execution.projectId,
        title: plan.expected.definition.execution.title,
        before: plan.expected.definition,
        after: null,
        expectedRevision: plan.expected.revision,
      };
    default:
      return null;
  }
}

const STATUS_RANK: Readonly<Record<AgentControlProposalStatus, number>> = {
  "pending-user-approval": 0,
  approved: 1,
  executing: 2,
  rejected: 3,
  expired: 3,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

/* One document per proposal id: the furthest along, then the latest written
   (the snapshot and the queue store can each be a step behind). */
function mergeProposals(
  ...sources: ReadonlyArray<ReadonlyArray<AgentControlProposal>>
): AgentControlProposal[] {
  const byId = new Map<string, AgentControlProposal>();
  for (const source of sources) {
    for (const proposal of source) {
      const current = byId.get(proposal.proposalId);
      if (
        !current ||
        STATUS_RANK[proposal.status] > STATUS_RANK[current.status] ||
        (STATUS_RANK[proposal.status] === STATUS_RANK[current.status] &&
          proposal.updatedAt > current.updatedAt)
      )
        byId.set(proposal.proposalId, proposal);
    }
  }
  return [...byId.values()];
}

const byCreated = (a: ScheduleProposal, b: ScheduleProposal) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const isPending = (p: ScheduleProposal, nowMs: number | undefined) =>
  p.status === "pending-user-approval" && (nowMs == null || p.expiresAtMs > nowMs);

/**
 * Schedule changes waiting for a decision, oldest first. With `nowMs`, one
 * past its deadline no longer counts (the server expires it on its next sweep).
 */
export function pendingScheduleProposals(
  proposals: ReadonlyArray<AgentControlProposal>,
  options: { readonly projectId?: ProjectId; readonly nowMs?: number } = {},
): ScheduleProposal[] {
  return mergeProposals(proposals)
    .map(scheduleProposalOf)
    .filter(
      (p): p is ScheduleProposal =>
        p !== null &&
        (options.projectId === undefined || p.projectId === options.projectId) &&
        isPending(p, options.nowMs),
    )
    .toSorted(byCreated);
}

export interface ScheduleRowsInput {
  readonly projectId: ProjectId;
  readonly snapshot: AutomationCentreSnapshot;
  /** The environment's Agent Control queue (active and recent proposals). */
  readonly queueProposals?: ReadonlyArray<AgentControlProposal>;
  /** Proposal ids the user dismissed ("Dismiss" / "Remove"; lapsed or failed) this session. */
  readonly dismissedLapsed?: ReadonlySet<string>;
  readonly nowMs: number;
}

/* The newest schedule proposal of each schedule in the project, from the
   snapshot's and the queue's copies. */
function newestScheduleProposals(
  input: ScheduleRowsInput,
): Map<AgentControlAutomationId, ScheduleProposal> {
  const newest = new Map<AgentControlAutomationId, ScheduleProposal>();
  for (const proposal of mergeProposals(input.snapshot.proposals, input.queueProposals ?? [])) {
    const p = scheduleProposalOf(proposal);
    if (!p || p.projectId !== input.projectId) continue;
    const current = newest.get(p.automationId);
    if (!current || byCreated(current, p) < 0) newest.set(p.automationId, p);
  }
  return newest;
}

/**
 * Schedule changes that expired undecided, by automation: the newest schedule
 * proposal for that automation expired (or is past its deadline) and nothing
 * newer was proposed. A create only counts while no such schedule exists; a
 * change only while its schedule is still there and not cancelled.
 */
export function lapsedScheduleProposals(
  input: ScheduleRowsInput,
): ReadonlyMap<AgentControlAutomationId, ScheduleProposal> {
  const automations = new Map(input.snapshot.automations.map((a) => [a.automationId, a]));
  const out = new Map<AgentControlAutomationId, ScheduleProposal>();
  for (const [automationId, p] of newestScheduleProposals(input)) {
    const lapsed =
      p.status === "expired" ||
      (p.status === "pending-user-approval" && p.expiresAtMs <= input.nowMs);
    if (!lapsed || input.dismissedLapsed?.has(p.id)) continue;
    const automation = automations.get(automationId);
    if (p.kind === "create" ? automation !== undefined : !automation || automation.cancelled)
      continue;
    out.set(automationId, p);
  }
  return out;
}

const failedAtMs = (p: ScheduleProposal) => {
  const result = p.proposal.result;
  return toMs(result?.outcome === "failed" ? result.failedAt : p.proposal.updatedAt);
};

/**
 * Approved schedule changes the server could not apply (status "failed",
 * `failure` says why), oldest failure first: the newest schedule proposal of
 * its schedule failed and nothing newer was proposed. Creates count too —
 * their row is gone, so this is the only trace. With `sinceMs`, only the ones
 * that failed at or after it (what failed while the dialog was open); the
 * dialog announces each once, like the lab's "The change couldn't be applied."
 */
export function failedScheduleProposals(
  input: ScheduleRowsInput & { readonly sinceMs?: number },
): ScheduleProposal[] {
  const out: ScheduleProposal[] = [];
  for (const p of newestScheduleProposals(input).values()) {
    if (p.status !== "failed" || input.dismissedLapsed?.has(p.id)) continue;
    if (input.sinceMs !== undefined && !(failedAtMs(p) >= input.sinceMs)) continue;
    out.push(p);
  }
  return out.toSorted((a, b) => failedAtMs(a) - failedAtMs(b) || byCreated(a, b));
}

function dueRunOf(
  entry: AutomationCentreRun,
  proposals: ReadonlyArray<AgentControlProposal>,
): ScheduleDueRun {
  const { run } = entry;
  const proposal =
    run.proposalId === null ? undefined : proposals.find((p) => p.proposalId === run.proposalId);
  const expiresAt =
    proposal?.expiresAt ??
    isoFromMs(toMs(run.updatedAt) + AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS);
  return {
    entry,
    proposalId: run.proposalId,
    expiresAt,
    expiresAtMs: toMs(expiresAt),
    scheduledFor: run.scheduledFor,
    scheduledForMs: toMs(run.scheduledFor),
    coalescedOccurrences: run.coalescedOccurrences,
  };
}

const byNewestRun = (a: AutomationCentreRun, b: AutomationCentreRun) =>
  toMs(b.run.createdAt) - toMs(a.run.createdAt) ||
  toMs(b.run.scheduledFor) - toMs(a.run.scheduledFor);

/**
 * The checkout's schedules as the dialog lists them: every schedule that is
 * not cancelled, plus proposed and lapsed new ones; new ones first, then by
 * title. State: a run waiting for approval → "awaiting-approval"; one being
 * prepared or started → "running"; disabled → "paused"; no run left →
 * "finished"; else "scheduled".
 */
export function deriveScheduleRows(input: ScheduleRowsInput): ScheduleRow[] {
  const { snapshot, nowMs } = input;
  const queue = input.queueProposals ?? [];
  const allProposals = mergeProposals(snapshot.proposals, queue);
  const pending = pendingScheduleProposals(allProposals, { projectId: input.projectId, nowMs });
  const pendingFor = new Map<string, ScheduleProposal>();
  for (const p of pending) pendingFor.set(p.automationId, p); // oldest first → newest wins
  const lapsed = lapsedScheduleProposals(input);
  const runsFor = new Map<string, AutomationCentreRun[]>();
  for (const entry of snapshot.runs) {
    const list = runsFor.get(entry.run.automationId);
    if (list) list.push(entry);
    else runsFor.set(entry.run.automationId, [entry]);
  }

  const rows: ScheduleRow[] = [];
  for (const automation of snapshot.automations) {
    if (automation.cancelled || automation.projectId !== input.projectId) continue;
    const runs = (runsFor.get(automation.automationId) ?? []).toSorted(byNewestRun);
    const due = runs.find((entry) => entry.run.status === "pending-approval") ?? null;
    const activeRun = runs.find((entry) => STARTING_RUN_STATUSES.has(entry.run.status)) ?? null;
    const history = runs.filter((entry) => !isActiveRun(entry));
    const proposal = pendingFor.get(automation.automationId) ?? null;
    const state: ScheduleRowState = due
      ? "awaiting-approval"
      : activeRun
        ? "running"
        : isSchedulePaused(automation)
          ? "paused"
          : !automation.enabled || automation.nextRunAt === null
            ? "finished"
            : "scheduled";
    rows.push({
      id: automation.automationId,
      automation,
      proposal,
      lapsed: proposal ? null : (lapsed.get(automation.automationId) ?? null),
      def: automation.definition,
      title: automation.definition.execution.title,
      projectId: automation.projectId,
      state,
      nextRunAt: automation.nextRunAt === null ? null : toMs(automation.nextRunAt),
      dueRun: due ? dueRunOf(due, allProposals) : null,
      activeRun,
      lastRun: history[0] ?? null,
      runs,
      history,
    });
  }
  const listed = new Set<string>(rows.map((row) => row.id));
  for (const p of pending) {
    if (p.kind !== "create" || !p.after || listed.has(p.automationId)) continue;
    if (snapshot.automations.some((a) => a.automationId === p.automationId)) continue;
    listed.add(p.automationId);
    rows.push(newRow(p, p.after, "pending-create", firstRun(p.after.schedule)));
  }
  for (const p of lapsed.values()) {
    if (p.kind !== "create" || !p.after || listed.has(p.automationId)) continue;
    listed.add(p.automationId);
    rows.push(newRow(p, p.after, "lapsed", null));
  }
  const isNew = (row: ScheduleRow) =>
    row.state === "pending-create" || row.state === "lapsed" ? 0 : 1;
  return rows.toSorted(
    (a, b) => isNew(a) - isNew(b) || (a.title || "").localeCompare(b.title || ""),
  );
}

function newRow(
  p: ScheduleProposal,
  after: AgentControlAutomationDefinition,
  state: "pending-create" | "lapsed",
  nextRunAt: number | null,
): ScheduleRow {
  return {
    id: p.automationId,
    automation: null,
    proposal: state === "pending-create" ? p : null,
    lapsed: state === "lapsed" ? p : null,
    def: after,
    title: after.execution.title,
    projectId: p.projectId,
    state,
    nextRunAt,
    dueRun: null,
    activeRun: null,
    lastRun: null,
    runs: [],
    history: [],
  };
}

/** The runs waiting for approval in a checkout, soonest deadline first. */
export function dueScheduleRuns(rows: ReadonlyArray<ScheduleRow>): ScheduleDueRun[] {
  return rows
    .flatMap((row) => (row.dueRun ? [row.dueRun] : []))
    .toSorted((a, b) => a.expiresAtMs - b.expiresAtMs);
}

/** What one list row says: title (+ tag), cadence (+ state, or the next run). */
export interface ScheduleRowPresentation {
  readonly title: string;
  readonly summary: string;
  readonly meta: string;
  readonly metaTone: "" | "fg";
  /** When set, the meta is this time relative to now (`rel`). */
  readonly soonAt: number | null;
  readonly tag: string;
  readonly tagTone: "" | "prop" | "lapsed" | "err";
}

export function scheduleRowPresentation(row: ScheduleRow, nowMs: number): ScheduleRowPresentation {
  let meta = "";
  let metaTone: ScheduleRowPresentation["metaTone"] = "";
  let soonAt: number | null = null;
  switch (row.state) {
    case "awaiting-approval":
      meta = "Waiting for approval";
      metaTone = "fg";
      break;
    case "running":
      meta = AUTOMATION_RUN_STATUS[row.activeRun?.run.status ?? "executing"].label;
      metaTone = "fg";
      break;
    case "paused":
      meta = "Paused";
      break;
    case "finished":
      meta = "Finished";
      break;
    case "pending-create":
      meta = "Not active yet";
      break;
    case "lapsed":
      meta = "Proposal expired";
      metaTone = "fg";
      break;
    default:
      soonAt = row.nextRunAt;
  }
  let tag = "";
  let tagTone: ScheduleRowPresentation["tagTone"] = "";
  if (row.proposal && row.proposal.kind !== "create") {
    tag = SCHEDULE_PROPOSAL_TAG[row.proposal.kind];
    tagTone = "prop";
  } else if (row.lapsed && row.lapsed.kind !== "create") {
    tag = SCHEDULE_LAPSED_TAG[row.lapsed.kind];
    tagTone = "lapsed";
  } else if (row.lastRun?.run.status === "failed") {
    tag = "Last run failed";
    tagTone = "err";
  }
  return {
    title: row.title || "Untitled schedule",
    summary: cadence(row.def.schedule, nowMs),
    meta,
    metaTone,
    soonAt,
    tag,
    tagTone,
  };
}

// ── Retry ────────────────────────────────────────────────────────────

export interface ScheduleRetryState {
  readonly ok: boolean;
  /** Why not, as a sentence (null when it can be retried). */
  readonly reason: string | null;
  /**
   * What a finished run's history row shows instead of Retry: a few words and
   * the full reason. `active` while another run of the schedule is in flight
   * (the history heading says it once). Null when nothing is said.
   */
  readonly block: {
    readonly short: string;
    readonly long: string;
    readonly active: boolean;
  } | null;
}

const RETRY_REASON = {
  missing: "This run is no longer available.",
  failed:
    "Delivery is uncertain for a failed dispatch. Open its thread or check the device before scheduling new work.",
  status: "Only rejected, expired or cancelled runs can be retried.",
  started:
    "This run may have started work. Open its thread to inspect or stop it before scheduling another task.",
  retried: "This run was already retried.",
  cancelled: "The schedule was cancelled.",
  changed: "The schedule changed since this run. Review it before running again.",
  busy: "Another run of this schedule is already waiting or running.",
} as const;

/**
 * Whether a run can be retried (asks for approval again), mirroring the
 * server: only a rejected, expired or cancelled run that never dispatched (no
 * threads; a cancelled one only before its approval was requested), of a
 * schedule that still exists at the same revision with no run in flight.
 */
export function scheduleRetryState(
  entry: AutomationCentreRun | null | undefined,
  rows: ReadonlyArray<ScheduleRow>,
): ScheduleRetryState {
  const no = (reason: string): ScheduleRetryState => ({ ok: false, reason, block: null });
  if (!entry) return no(RETRY_REASON.missing);
  const { run } = entry;
  if (run.status === "failed") return no(RETRY_REASON.failed);
  if (!RETRYABLE_RUN_STATUSES.has(run.status)) return no(RETRY_REASON.status);
  const row = rows.find((r) => r.id === run.automationId) ?? null;
  const runs = row?.runs ?? [];
  const active = runs.find(isActiveRun) ?? null;
  const reason = (() => {
    if (entry.threadIds.length > 0 || (run.status === "cancelled" && run.proposalId !== null))
      return RETRY_REASON.started;
    if (runs.some((r) => r.retryOfRunId === run.runId)) return RETRY_REASON.retried;
    if (!row?.automation || row.automation.cancelled) return RETRY_REASON.cancelled;
    if (row.automation.revision !== run.automationRevision) return RETRY_REASON.changed;
    if (active) return RETRY_REASON.busy;
    return null;
  })();
  if (reason === null) return { ok: true, reason: null, block: null };
  // Possibly dispatched: no hint that a retry might open later.
  if (reason === RETRY_REASON.started) return no(reason);
  if (active)
    return {
      ok: false,
      reason,
      block: {
        short:
          active.run.status === "pending-approval"
            ? "Retry opens once the waiting run is decided."
            : "Retry opens once the current run is dispatched.",
        long: reason,
        active: true,
      },
    };
  if (runs.some((r) => r.retryOfRunId === run.runId))
    return { ok: false, reason, block: { short: "Retried", long: reason, active: false } };
  if (reason === RETRY_REASON.changed)
    return {
      ok: false,
      reason,
      block: { short: "Schedule changed since", long: reason, active: false },
    };
  return no(reason);
}

// ── Words for definitions ────────────────────────────────────────────

/** "a new worktree" · "the main checkout" */
export function envWords(mode: ThreadEnvMode): string {
  return mode === "local" ? "the main checkout" : "a new worktree";
}

const EFFORT_OPTION_IDS = ["effort", "reasoningEffort"] as const;

/** "Sonnet 5.5", or with `{ effort: true }` "Sonnet 5.5 · High". */
export function scheduleModelLabel(
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<AutomationProviderInfo> = [],
  options: { readonly effort?: boolean } = {},
): string {
  if (!selection) return "No model";
  const model = providers
    .find((p) => p.instanceId === selection.instanceId)
    ?.models.find((m) => m.slug === selection.model);
  const name = model ? getModelDisplayName(model) : selection.model;
  if (!options.effort) return name;
  const option = selection.options?.find((o) =>
    (EFFORT_OPTION_IDS as ReadonlyArray<string>).includes(o.id),
  );
  if (!option || typeof option.value !== "string" || !option.value) return name;
  const value = option.value;
  const descriptor = model?.capabilities?.optionDescriptors?.find((d) => d.id === option.id);
  const label =
    descriptor?.type === "select"
      ? descriptor.options.find((choice) => choice.id === value)?.label
      : undefined;
  return `${name} · ${label ?? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`}`;
}

export type ScheduleDiffKey =
  | "when"
  | "runsAt"
  | "every"
  | "nextRun"
  | "ends"
  | "title"
  | "prompt"
  | "model"
  | "effort"
  | "permissions"
  | "runsIn"
  | "branch";

export interface ScheduleDiffRow {
  readonly key: ScheduleDiffKey;
  readonly label: string;
  /** Struck-through old value; null where only the new one is said ("Prompt"). */
  readonly before: string | null;
  readonly after: string;
}

/**
 * What a proposed edit changes, one row per fact. A start rolled forward to
 * the same next occurrence is not a change.
 */
export function diffScheduleDefinitions(
  before: AgentControlAutomationDefinition,
  after: AgentControlAutomationDefinition,
  options: {
    readonly nowMs: number;
    /** The app's one vocabulary for runtime modes. */
    readonly runtimeModeLabel: (mode: RuntimeMode) => string;
    readonly providers?: ReadonlyArray<AutomationProviderInfo>;
  },
): ScheduleDiffRow[] {
  const { nowMs } = options;
  const out: ScheduleDiffRow[] = [];
  const push = (key: ScheduleDiffKey, label: string, b: string | null, a: string) =>
    out.push({ key, label, before: b, after: a });
  const bs = scheduleToMs(before.schedule);
  const as = scheduleToMs(after.schedule);
  if (bs.kind !== as.kind) push("when", "When", scheduleLabel(bs, nowMs), scheduleLabel(as, nowMs));
  else if (bs.kind === "once" && as.kind === "once") {
    if (bs.runAt !== as.runAt)
      push("runsAt", "Runs at", when(bs.runAt, nowMs), when(as.runAt, nowMs));
  } else if (bs.kind === "fixed-interval" && as.kind === "fixed-interval") {
    if (bs.intervalMs !== as.intervalMs)
      push("every", "Every", everyWords(bs.intervalMs), everyWords(as.intervalMs));
    const beforeNext = nextRun(bs, nowMs) ?? bs.startsAt;
    const samePhase =
      bs.intervalMs === as.intervalMs && (as.startsAt - bs.startsAt) % as.intervalMs === 0;
    if (!samePhase && beforeNext !== as.startsAt)
      push("nextRun", "Next run", when(beforeNext, nowMs), when(as.startsAt, nowMs));
    if (bs.endsAt !== as.endsAt)
      push("ends", "Ends", formatDate(bs.endsAt, nowMs), formatDate(as.endsAt, nowMs));
  }
  const be = before.execution;
  const ae = after.execution;
  if (be.title !== ae.title) push("title", "Title", be.title, ae.title);
  if (be.prompt !== ae.prompt) {
    const added = ae.prompt.startsWith(be.prompt) ? ae.prompt.slice(be.prompt.length).trim() : null;
    push("prompt", "Prompt", null, added ? `+ “${added}”` : "Rewritten");
  }
  const providers = options.providers ?? [];
  if (
    be.modelSelection.model !== ae.modelSelection.model ||
    be.modelSelection.instanceId !== ae.modelSelection.instanceId
  )
    push(
      "model",
      "Model",
      scheduleModelLabel(be.modelSelection, providers),
      scheduleModelLabel(ae.modelSelection, providers),
    );
  else {
    const b = scheduleModelLabel(be.modelSelection, providers, { effort: true });
    const a = scheduleModelLabel(ae.modelSelection, providers, { effort: true });
    if (b !== a) push("effort", "Effort", b, a);
  }
  if (be.runtimeMode !== ae.runtimeMode)
    push(
      "permissions",
      "Permissions",
      options.runtimeModeLabel(be.runtimeMode),
      options.runtimeModeLabel(ae.runtimeMode),
    );
  if (be.envMode !== ae.envMode)
    push("runsIn", "Runs in", envWords(be.envMode), envWords(ae.envMode));
  else if (ae.envMode === "worktree" && (be.baseRef ?? "") !== (ae.baseRef ?? ""))
    push("branch", "Branch", be.baseRef ?? "—", ae.baseRef ?? "—");
  return out;
}

// ── Drafts ───────────────────────────────────────────────────────────

/** The editor's working copy: flat, millisecond times. */
export interface ScheduleDraft {
  /** The schedule it edits (or re-proposes); null for a new one. */
  readonly id: AgentControlAutomationId | null;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly envMode: ThreadEnvMode;
  /**
   * The branch a worktree run starts off; "" when the schedule names none
   * (the server's default — kept as is on save). A local schedule's draft
   * holds the default branch for a switch to a worktree.
   */
  readonly baseRef: string;
  /** Carried through unchanged; the editor does not offer it. */
  readonly tokenMode: AgentTokenMode | null;
  readonly kind: "once" | "fixed-interval";
  /** The run (once) or the first run (repeats). */
  readonly start: number;
  readonly intervalMs: number;
  readonly endsAt: number;
  readonly enabled: boolean;
}

/**
 * The editor's draft of a definition, as is (no roll-forward). A worktree
 * schedule keeps its branch, or none; `defaultBaseRef` (else "main") only
 * pre-fills a local one's, for a switch to a worktree.
 */
export function draftFromDefinition(
  definition: AgentControlAutomationDefinition,
  options: { readonly id?: AgentControlAutomationId | null; readonly defaultBaseRef?: string } = {},
): ScheduleDraft {
  const ex = definition.execution;
  const s = scheduleToMs(definition.schedule);
  const start = s.kind === "once" ? s.runAt : s.startsAt;
  return {
    id: options.id ?? null,
    projectId: ex.projectId,
    title: ex.title,
    prompt: ex.prompt,
    modelSelection: ex.modelSelection,
    runtimeMode: ex.runtimeMode,
    envMode: ex.envMode,
    baseRef: ex.envMode === "worktree" ? (ex.baseRef ?? "") : (options.defaultBaseRef ?? "main"),
    tokenMode: ex.tokenMode ?? null,
    kind: s.kind,
    start,
    intervalMs: s.kind === "once" ? DAY_MS : s.intervalMs,
    endsAt: s.kind === "once" ? addDays(start, 7) : s.endsAt,
    enabled: definition.enabled,
  };
}

/** The draft's schedule in milliseconds. */
export function draftSchedule(draft: ScheduleDraft): ScheduleMs {
  return draft.kind === "once"
    ? { kind: "once", runAt: draft.start }
    : {
        kind: "fixed-interval",
        startsAt: draft.start,
        intervalMs: draft.intervalMs,
        endsAt: draft.endsAt,
      };
}

/** The contract definition a draft saves as (title and prompt trimmed). */
export function definitionFromDraft(draft: ScheduleDraft): AgentControlAutomationDefinition {
  const baseRef = draft.baseRef.trim();
  const execution: AgentControlAutomationExecutionTemplate = {
    projectId: draft.projectId,
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    modelSelection: draft.modelSelection,
    runtimeMode: draft.runtimeMode,
    ...(draft.tokenMode ? { tokenMode: draft.tokenMode } : {}),
    envMode: draft.envMode,
    ...(draft.envMode === "worktree" && baseRef ? { baseRef } : {}),
  };
  return {
    execution,
    schedule: scheduleToContract(draftSchedule(draft)),
    enabled: draft.enabled,
  };
}

/** A stable key of what a draft would save — compare it to tell a dirty draft. */
export function scheduleDraftKey(draft: ScheduleDraft): string {
  return JSON.stringify(definitionFromDraft(draft));
}

/**
 * A fresh draft: repeats every 24 hours from tomorrow 09:00 for 30 days, in a
 * new worktree off `baseRef` (default "main"), accepting edits.
 */
export function blankScheduleDraft(input: {
  readonly projectId: ProjectId;
  readonly nowMs: number;
  readonly modelSelection: ModelSelection;
  readonly baseRef?: string;
}): ScheduleDraft {
  const tomorrow9 = new Date(input.nowMs);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  const start = tomorrow9.getTime();
  return {
    id: null,
    projectId: input.projectId,
    title: "",
    prompt: "",
    modelSelection: input.modelSelection,
    runtimeMode: "auto-accept-edits",
    envMode: "worktree",
    baseRef: input.baseRef ?? "main",
    tokenMode: null,
    kind: "fixed-interval",
    start,
    intervalMs: DAY_MS,
    endsAt: start + 30 * DAY_MS,
    enabled: true,
  };
}

/**
 * An editable draft of a schedule or of a proposal's definition (the proposed
 * one, else the one it changes), its past start rolled forward to the next
 * occurrence — the backend rejects a past start, even on edits.
 */
export function draftOfLatest(
  source: AgentControlAutomation | ScheduleProposal,
  nowMs: number,
  options: { readonly defaultBaseRef?: string } = {},
): ScheduleDraft {
  const isAutomation = "definition" in source;
  const definition = isAutomation ? source.definition : (source.after ?? source.before);
  const id = source.automationId;
  if (!definition) throw new Error("A schedule proposal always carries a definition.");
  const draft = draftFromDefinition(
    { ...definition, schedule: scheduleToContract(rollForward(definition.schedule, nowMs)) },
    { id, ...(options.defaultBaseRef ? { defaultBaseRef: options.defaultBaseRef } : {}) },
  );
  return draft;
}

/**
 * The definition a pause (`enabled: false`) or resume proposes: the same
 * schedule, its start rolled to the first run after the approval window
 * (now + 15 min) — the server re-checks the start when the approved change
 * is applied, and a start inside the window would fail a later approval. A
 * resumed schedule's first run is therefore never inside that window; the
 * proposal shows it ("the first run is …"). A one-off run is never moved.
 */
export function definitionWithEnabled(
  automation: AgentControlAutomation,
  enabled: boolean,
  nowMs: number,
): AgentControlAutomationDefinition {
  return {
    ...automation.definition,
    schedule: scheduleToContract(
      rollForward(automation.definition.schedule, nowMs, {
        leadMs: AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
      }),
    ),
    enabled,
  };
}

// ── Draft validation ─────────────────────────────────────────────────

/**
 * The draft against the server's rules and the editor's (see
 * `validateScheduleDefinition`). With the checkout's snapshot, the active
 * limit applies to a new schedule or a stopped one being re-enabled.
 */
export function validateScheduleDraft(
  draft: ScheduleDraft,
  options: {
    readonly nowMs: number;
    readonly snapshot?: AutomationCentreSnapshot | null;
    readonly providers?: ReadonlyArray<AutomationProviderInfo>;
    readonly projectName?: string;
  },
): { readonly ok: boolean; readonly errors: ScheduleErrors } {
  const existing =
    draft.id && options.snapshot
      ? options.snapshot.automations.find((a) => a.automationId === draft.id)
      : undefined;
  return validateScheduleDefinition(
    {
      execution: {
        title: draft.title,
        prompt: draft.prompt,
        modelSelection: draft.modelSelection,
      },
      schedule: draftSchedule(draft),
      enabled: draft.enabled,
    },
    options.nowMs,
    {
      ...(options.snapshot ? { activeCount: activeScheduleCount(options.snapshot) } : {}),
      editingActive: isScheduleActive(existing),
      ...(options.projectName ? { projectName: options.projectName } : {}),
      ...(options.providers ? { providers: options.providers } : {}),
    },
  );
}

/**
 * Where "Use …" moves a past start: a repeating schedule's next occurrence
 * when that is inside the window, else the next quarter hour.
 */
export function startFix(draft: ScheduleDraft, nowMs: number): number {
  if (draft.kind !== "once") {
    const rolled = rollForward(draftSchedule(draft), nowMs);
    const start = rolled.kind === "once" ? rolled.runAt : rolled.startsAt;
    if (start > nowMs && start <= nowMs + AUTOMATION_LIMITS.horizonMs) return start;
  }
  return ceilQuarter(nowMs + MINUTE_MS);
}

export interface ScheduleDraftMessage {
  readonly key: "start" | "interval" | "end" | "title";
  readonly text: string;
  /** A one-click fix: set the field to `value`. */
  readonly fix: { readonly label: string; readonly value: number } | null;
}

/**
 * The editor's inline messages, in minute-stable words, each keyed so the
 * region can be patched per message. The title's only after a save attempt
 * or once the title was touched.
 */
export function scheduleDraftMessages(
  draft: ScheduleDraft,
  errors: ScheduleErrors,
  options: {
    readonly nowMs: number;
    readonly attempted?: boolean;
    readonly titleTouched?: boolean;
  },
): ScheduleDraftMessage[] {
  const now = options.nowMs;
  const out: ScheduleDraftMessage[] = [];
  if (errors.start) {
    const past = draft.start <= now;
    const fix = past
      ? startFix(draft, now)
      : ceilQuarter(now + AUTOMATION_LIMITS.horizonMs - 15 * MINUTE_MS);
    out.push({
      key: "start",
      text: past
        ? draft.kind === "once"
          ? "That time has passed."
          : "Starts in the past."
        : "More than 90 days ahead.",
      fix: { label: `Use ${when(fix, now)}`, value: fix },
    });
  }
  if (errors.interval)
    out.push({
      key: "interval",
      text: "Under the 15-minute minimum.",
      fix: { label: "Use 15 minutes", value: 15 * MINUTE_MS },
    });
  if (errors.end) {
    const horizon = floorMinute(now + AUTOMATION_LIMITS.horizonMs);
    if (draft.endsAt < draft.start) {
      const fix = Math.min(addDays(draft.start, 7), horizon);
      out.push({
        key: "end",
        text: "Ends before the first run.",
        fix: fix >= draft.start ? { label: `End ${formatDate(fix, now)}`, value: fix } : null,
      });
    } else
      out.push({
        key: "end",
        text: "Ends past the 90-day limit.",
        fix: { label: `End ${formatDate(horizon, now)}`, value: horizon },
      });
  }
  if (errors.title && (options.attempted || options.titleTouched))
    out.push({ key: "title", text: errors.title, fix: null });
  return out;
}
