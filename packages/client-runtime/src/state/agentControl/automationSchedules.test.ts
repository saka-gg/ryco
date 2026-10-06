process.env.TZ = "Europe/Berlin";

import {
  AgentControlAutomationId,
  AgentControlAutomationRunId,
  AgentControlProposalId,
  AgentControlRequestId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentControlActionPlan,
  type AgentControlAutomation,
  type AgentControlAutomationDefinition,
  type AgentControlAutomationRunStatus,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type AutomationCentreRun,
  type AutomationCentreSnapshot,
  type RuntimeMode,
} from "@ryco/contracts";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  scheduleToContract,
  type AutomationProviderInfo,
  type ScheduleMs,
} from "@ryco/shared/automationSchedule";
import { describe, expect, it } from "vite-plus/test";

import { automationRunStatusLabel } from "./automationCentre.ts";
import {
  AUTOMATION_RUN_STATUS,
  activeScheduleCount,
  blankScheduleDraft,
  definitionFromDraft,
  definitionWithEnabled,
  deriveScheduleRows,
  diffScheduleDefinitions,
  draftFromDefinition,
  draftOfLatest,
  dueScheduleRuns,
  isSchedulePaused,
  failedScheduleProposals,
  lapsedScheduleProposals,
  pendingScheduleProposals,
  scheduleDraftKey,
  scheduleDraftMessages,
  scheduleModelLabel,
  scheduleProposalFailure,
  scheduleProposalOf,
  scheduleRetryState,
  scheduleRowPresentation,
  startFix,
  validateScheduleDraft,
  type ScheduleRow,
} from "./automationSchedules.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const T = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm).getTime();
/** The lab's fixed now: Wed Oct 7 2026, 10:42 in Berlin. */
const NOW = T(2026, 10, 7, 10, 42);
const iso = (ms: number) => new Date(ms).toISOString();
const PROJECT = ProjectId.make("ryco");
const OTHER_PROJECT = ProjectId.make("ryco-hub");
const CLAUDE = ProviderInstanceId.make("claude");
const aid = (id: string) => AgentControlAutomationId.make(id);
const pid = (id: string) => AgentControlProposalId.make(id);
const rid = (id: string) => AgentControlAutomationRunId.make(id);
const runtimeModeLabel = (mode: RuntimeMode) =>
  ({
    "approval-required": "Supervised",
    "auto-accept-edits": "Auto-accept edits",
    auto: "Auto",
    "full-access": "Full access",
  })[mode];

const every = (startsAt: number, intervalMs: number, endsAt: number): ScheduleMs => ({
  kind: "fixed-interval",
  startsAt,
  intervalMs,
  endsAt,
});

function definition(
  title: string,
  schedule: ScheduleMs,
  patch: {
    readonly enabled?: boolean;
    readonly projectId?: ProjectId;
    readonly execution?: Partial<AgentControlAutomationDefinition["execution"]>;
  } = {},
): AgentControlAutomationDefinition {
  return {
    execution: {
      projectId: patch.projectId ?? PROJECT,
      title,
      prompt: `Run ${title}.`,
      modelSelection: {
        instanceId: CLAUDE,
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "auto-accept-edits",
      envMode: "worktree",
      baseRef: "main",
      ...patch.execution,
    },
    schedule: scheduleToContract(schedule),
    enabled: patch.enabled ?? true,
  };
}

function automation(
  id: string,
  def: AgentControlAutomationDefinition,
  patch: {
    readonly revision?: number;
    readonly nextRunAt?: number | null;
    readonly cancelled?: boolean;
    /** The stored flag; the server turns it off once the last run came due. */
    readonly enabled?: boolean;
  } = {},
): AgentControlAutomation {
  const s = def.schedule;
  const first = s.kind === "once" ? s.runAt : s.startsAt;
  const nextRunAt = patch.nextRunAt === undefined ? Date.parse(first) : patch.nextRunAt;
  return {
    automationId: aid(id),
    principal: {
      kind: "automation-owner",
      projectId: def.execution.projectId,
      runtimeMode: def.execution.runtimeMode,
      envMode: def.execution.envMode,
    },
    projectId: def.execution.projectId,
    providerInstanceId: CLAUDE,
    definition: def,
    revision: patch.revision ?? 1,
    enabled: patch.enabled ?? def.enabled,
    cancelled: patch.cancelled ?? false,
    cancelledAt: patch.cancelled ? iso(NOW - DAY_MS) : null,
    nextRunAt: def.enabled && nextRunAt !== null ? iso(nextRunAt) : null,
    createdAt: iso(NOW - 10 * DAY_MS),
    updatedAt: iso(NOW - DAY_MS),
  };
}

function run(
  id: string,
  automationId: string,
  status: AgentControlAutomationRunStatus,
  patch: {
    readonly at?: number;
    readonly proposalId?: string | null;
    readonly threadIds?: readonly string[];
    readonly retryOf?: string;
    readonly revision?: number;
    readonly coalesced?: number;
  } = {},
): AutomationCentreRun {
  const at = patch.at ?? NOW - HOUR_MS;
  return {
    run: {
      runId: rid(id),
      automationId: aid(automationId),
      automationRevision: patch.revision ?? 1,
      projectId: PROJECT,
      providerInstanceId: CLAUDE,
      scheduledFor: iso(at),
      coalescedOccurrences: patch.coalesced ?? 0,
      status,
      proposalId:
        patch.proposalId === undefined ? pid(`p-${id}`) : patch.proposalId && pid(patch.proposalId),
      safeFailureDetail: status === "failed" ? "Approved run failed safely." : null,
      createdAt: iso(at),
      updatedAt: iso(at + MINUTE_MS),
      completedAt: null,
    },
    execution: null,
    threadIds: (patch.threadIds ?? []).map((t) => ThreadId.make(t)),
    unread: true,
    retryOfRunId: patch.retryOf ? rid(patch.retryOf) : null,
  };
}

function proposal(
  id: string,
  plan: AgentControlActionPlan,
  patch: {
    readonly status?: AgentControlProposalStatus;
    readonly createdAt?: number;
    readonly expiresAt?: number;
    /** A failed result with this error message (status "failed"). */
    readonly failedWith?: string;
    readonly failedAt?: number;
  } = {},
): AgentControlProposal {
  const createdAt = patch.createdAt ?? NOW - 5 * MINUTE_MS;
  const failedAt = patch.failedAt ?? createdAt + MINUTE_MS;
  return {
    proposalId: pid(id),
    requestId: AgentControlRequestId.make(`request-${id}`),
    principal: {
      kind: "automation-owner",
      projectId: PROJECT,
      runtimeMode: "auto-accept-edits",
      envMode: "worktree",
    },
    planVersion: 1,
    plan,
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Schedule change",
    status: patch.failedWith !== undefined ? "failed" : (patch.status ?? "pending-user-approval"),
    createdAt: iso(createdAt),
    updatedAt: iso(patch.failedWith !== undefined ? failedAt : createdAt),
    expiresAt: iso(patch.expiresAt ?? createdAt + 15 * MINUTE_MS),
    decidedAt: patch.failedWith !== undefined ? iso(failedAt) : null,
    result:
      patch.failedWith !== undefined
        ? {
            outcome: "failed",
            error: { code: "execution-failed", message: patch.failedWith, retryable: true },
            failedAt: iso(failedAt),
          }
        : null,
  };
}

const createPlan = (id: string, def: AgentControlAutomationDefinition): AgentControlActionPlan => ({
  kind: "createAutomation",
  automationId: aid(id),
  definition: def,
});
const updatePlan = (
  a: AgentControlAutomation,
  after: AgentControlAutomationDefinition,
): AgentControlActionPlan => ({
  kind: "updateAutomation",
  automationId: a.automationId,
  before: {
    revision: a.revision,
    definition: a.definition,
    cancelled: a.cancelled,
    updatedAt: a.updatedAt,
  },
  after,
});
const cancelPlan = (a: AgentControlAutomation): AgentControlActionPlan => ({
  kind: "cancelAutomation",
  automationId: a.automationId,
  expected: {
    revision: a.revision,
    definition: a.definition,
    cancelled: a.cancelled,
    updatedAt: a.updatedAt,
  },
});
const runPlan = (entry: AutomationCentreRun, def: AgentControlAutomationDefinition) =>
  ({
    kind: "automationRun",
    automationId: entry.run.automationId,
    runId: entry.run.runId,
    automationRevision: entry.run.automationRevision,
    scheduledFor: entry.run.scheduledFor,
    coalescedOccurrences: entry.run.coalescedOccurrences,
    execution: def.execution,
  }) satisfies AgentControlActionPlan;

function snapshot(patch: Partial<AutomationCentreSnapshot> = {}): AutomationCentreSnapshot {
  return {
    automations: [],
    runs: [],
    proposals: [],
    unavailableRecords: 0,
    historyLimit: 50,
    ...patch,
  };
}

const rowsOf = (
  snap: AutomationCentreSnapshot,
  extra: {
    readonly queueProposals?: ReadonlyArray<AgentControlProposal>;
    readonly dismissedLapsed?: ReadonlySet<string>;
    readonly nowMs?: number;
  } = {},
) =>
  deriveScheduleRows({
    projectId: PROJECT,
    snapshot: snap,
    nowMs: extra.nowMs ?? NOW,
    ...(extra.queueProposals ? { queueProposals: extra.queueProposals } : {}),
    ...(extra.dismissedLapsed ? { dismissedLapsed: extra.dismissedLapsed } : {}),
  });
const rowById = (rows: ReadonlyArray<ScheduleRow>, id: string) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

const twoHourly = definition(
  "Triage issues",
  every(T(2026, 10, 7, 12, 0), 2 * HOUR_MS, T(2026, 10, 31, 12, 0)),
);
const nightly = definition(
  "Nightly deps",
  every(T(2026, 10, 8, 3, 0), DAY_MS, T(2026, 11, 6, 3, 0)),
);

// ── Run status ───────────────────────────────────────────────────────

describe("run status vocabulary", () => {
  it("uses the dialog's words app-wide", () => {
    expect(automationRunStatusLabel).toEqual({
      materializing: "Preparing",
      "pending-approval": "Waiting for approval",
      approved: "Approved",
      executing: "Starting",
      completed: "Dispatched",
      failed: "Failed",
      rejected: "Rejected",
      expired: "Expired",
      cancelled: "Cancelled",
    });
  });

  it("keeps one hue for failure and marks in-flight statuses active", () => {
    expect(AUTOMATION_RUN_STATUS.failed.tone).toBe("err");
    expect(AUTOMATION_RUN_STATUS.completed).toEqual({
      label: "Dispatched",
      tone: "fg",
      active: false,
    });
    expect(AUTOMATION_RUN_STATUS["pending-approval"]).toMatchObject({ tone: "wait", active: true });
    expect(
      Object.entries(AUTOMATION_RUN_STATUS)
        .filter(([, s]) => s.active)
        .map(([k]) => k),
    ).toEqual(["materializing", "pending-approval", "approved", "executing"]);
  });
});

// ── Rows ─────────────────────────────────────────────────────────────

describe("deriveScheduleRows", () => {
  it("derives every state, new schedules first, then by title", () => {
    const scheduled = automation("a-sched", twoHourly);
    const due = automation(
      "a-due",
      definition("Daily summary", every(T(2026, 10, 1, 9, 0), DAY_MS, T(2026, 10, 30, 9, 0))),
      {
        nextRunAt: T(2026, 10, 8, 9, 0),
      },
    );
    const starting = automation(
      "a-start",
      definition("Changelog", every(T(2026, 10, 7, 10, 0), HOUR_MS, T(2026, 10, 9, 10, 0))),
      {
        nextRunAt: T(2026, 10, 7, 11, 0),
      },
    );
    const preparing = automation(
      "a-prep",
      definition("Backups", every(T(2026, 10, 7, 10, 30), HOUR_MS, T(2026, 10, 9, 10, 0))),
      {
        nextRunAt: T(2026, 10, 7, 11, 30),
      },
    );
    const paused = automation(
      "a-paused",
      definition("Paused one", every(T(2026, 10, 1, 9, 0), DAY_MS, T(2026, 10, 30, 9, 0)), {
        enabled: false,
      }),
    );
    const finished = automation(
      "a-done",
      definition("Finished one", { kind: "once", runAt: T(2026, 10, 6, 9, 0) }),
      // As the server stores it: still enabled by the user, switched off at its last run.
      { nextRunAt: null, enabled: false },
    );
    const cancelled = automation(
      "a-gone",
      definition("Cancelled one", every(T(2026, 10, 1, 9, 0), DAY_MS, T(2026, 10, 30, 9, 0))),
      {
        cancelled: true,
      },
    );
    const elsewhere = automation(
      "a-hub",
      definition("Hub", every(NOW + HOUR_MS, DAY_MS, NOW + 9 * DAY_MS), {
        projectId: OTHER_PROJECT,
      }),
    );
    const dueRun = run("r-due", "a-due", "pending-approval", {
      at: T(2026, 10, 7, 9, 0),
      coalesced: 3,
    });
    const newDef = definition(
      "A new one",
      every(T(2026, 10, 9, 9, 0), DAY_MS, T(2026, 10, 16, 9, 0)),
    );
    const lapsedDef = definition("Expired idea", { kind: "once", runAt: T(2026, 10, 9, 9, 0) });
    const snap = snapshot({
      automations: [scheduled, due, starting, preparing, paused, finished, cancelled, elsewhere],
      runs: [
        dueRun,
        run("r-due-old", "a-due", "completed", { at: T(2026, 10, 6, 9, 0), threadIds: ["t1"] }),
        run("r-start", "a-start", "executing", { at: T(2026, 10, 7, 10, 0) }),
        run("r-prep", "a-prep", "materializing", { at: T(2026, 10, 7, 10, 30), proposalId: null }),
        run("r-done", "a-done", "failed", { at: T(2026, 10, 6, 9, 0) }),
      ],
      proposals: [
        proposal("p-r-due", runPlan(dueRun, due.definition), { expiresAt: NOW + 13 * MINUTE_MS }),
        proposal("p-new", createPlan("a-new", newDef)),
      ],
    });
    const queue = [
      proposal("p-lapsed", createPlan("a-lapsed", lapsedDef), {
        status: "expired",
        createdAt: NOW - HOUR_MS,
      }),
    ];
    const rows = rowsOf(snap, { queueProposals: queue });
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["a-new", "pending-create"],
      ["a-lapsed", "lapsed"],
      ["a-prep", "running"],
      ["a-start", "running"],
      ["a-due", "awaiting-approval"],
      ["a-done", "finished"],
      ["a-paused", "paused"],
      ["a-sched", "scheduled"],
    ]);

    const dueRow = rowById(rows, "a-due");
    expect(dueRow.dueRun).toMatchObject({
      proposalId: "p-r-due",
      expiresAt: iso(NOW + 13 * MINUTE_MS),
      expiresAtMs: NOW + 13 * MINUTE_MS,
      scheduledForMs: T(2026, 10, 7, 9, 0),
      coalescedOccurrences: 3,
      scheduledFor: iso(T(2026, 10, 7, 9, 0)),
    });
    expect(dueRow.lastRun?.run.runId).toBe("r-due-old");
    expect(dueRow.history.map((r) => r.run.runId)).toEqual(["r-due-old"]);
    expect(dueRow.runs.map((r) => r.run.runId)).toEqual(["r-due", "r-due-old"]);
    expect(rowById(rows, "a-start").activeRun?.run.status).toBe("executing");
    expect(rowById(rows, "a-sched").nextRunAt).toBe(T(2026, 10, 7, 12, 0));
    expect(rowById(rows, "a-paused").nextRunAt).toBeNull();
    expect(isSchedulePaused(rowById(rows, "a-paused").automation)).toBe(true);
    // Switched off by the server at its last run: finished, never "paused".
    expect(isSchedulePaused(rowById(rows, "a-done").automation)).toBe(false);

    const created = rowById(rows, "a-new");
    expect(created).toMatchObject({
      automation: null,
      title: "A new one",
      nextRunAt: T(2026, 10, 9, 9, 0),
      def: newDef,
    });
    expect(created.proposal?.kind).toBe("create");
    expect(rowById(rows, "a-lapsed")).toMatchObject({
      nextRunAt: null,
      proposal: null,
      def: lapsedDef,
    });
    expect(rowById(rows, "a-lapsed").lapsed?.id).toBe("p-lapsed");
    expect(dueScheduleRuns(rows).map((d) => d.entry.run.runId)).toEqual(["r-due"]);
  });

  it("presents each row like the lab's list", () => {
    const scheduled = automation("a-sched", twoHourly);
    const prep = automation("a-prep", nightly, { nextRunAt: T(2026, 10, 8, 3, 0) });
    const snap = snapshot({
      automations: [scheduled, prep],
      runs: [
        run("r-prep", "a-prep", "materializing", { proposalId: null }),
        run("r-fail", "a-sched", "failed", { at: NOW - 2 * HOUR_MS }),
      ],
    });
    const rows = rowsOf(snap);
    expect(scheduleRowPresentation(rowById(rows, "a-sched"), NOW)).toEqual({
      title: "Triage issues",
      summary: "Every 2 h",
      meta: "",
      metaTone: "",
      soonAt: T(2026, 10, 7, 12, 0),
      tag: "Last run failed",
      tagTone: "err",
    });
    expect(scheduleRowPresentation(rowById(rows, "a-prep"), NOW)).toMatchObject({
      summary: "Every 24 h from 03:00",
      meta: "Preparing",
      metaTone: "fg",
      soonAt: null,
    });
  });

  it("falls back to the run's 15-minute window when its proposal is not in view", () => {
    const due = automation("a-due", twoHourly);
    const entry = run("r-due", "a-due", "pending-approval", { at: NOW - 2 * MINUTE_MS });
    const rows = rowsOf(snapshot({ automations: [due], runs: [entry] }));
    expect(rowById(rows, "a-due").dueRun?.expiresAt).toBe(iso(NOW - MINUTE_MS + 15 * MINUTE_MS));
  });

  it("reads the queue store's copy of a run proposal", () => {
    const due = automation("a-due", twoHourly);
    const entry = run("r-due", "a-due", "pending-approval");
    const queue = [
      proposal("p-r-due", runPlan(entry, twoHourly), { expiresAt: NOW + 4 * MINUTE_MS }),
    ];
    const rows = rowsOf(snapshot({ automations: [due], runs: [entry] }), { queueProposals: queue });
    expect(rowById(rows, "a-due").dueRun?.expiresAt).toBe(iso(NOW + 4 * MINUTE_MS));
  });
});

// ── Proposals ────────────────────────────────────────────────────────

describe("schedule proposals", () => {
  const a = automation("a-sched", twoHourly, { revision: 3 });

  it("reads pause and resume when only enabled flips (start rolled forward)", () => {
    const later = NOW + 5 * HOUR_MS;
    const pause = scheduleProposalOf(
      proposal("p1", updatePlan(a, definitionWithEnabled(a, false, later))),
    );
    expect(pause).toMatchObject({ kind: "pause", expectedRevision: 3, title: "Triage issues" });
    // The rolled start moved to a later occurrence of the same schedule.
    expect(definitionWithEnabled(a, false, later).schedule).toMatchObject({
      startsAt: iso(T(2026, 10, 7, 16, 0)),
    });
    const paused = automation(
      "a-paused",
      definition("Paused", every(T(2026, 10, 1, 9, 0), DAY_MS, T(2026, 10, 30, 9, 0)), {
        enabled: false,
      }),
    );
    expect(
      scheduleProposalOf(
        proposal("p2", updatePlan(paused, definitionWithEnabled(paused, true, NOW))),
      )?.kind,
    ).toBe("resume");
  });

  it("rolls a pause or resume past the approval window, still reading as one", () => {
    const quarter = automation(
      "a-quarter",
      definition("Quarter", every(T(2026, 10, 7, 8, 39), 15 * MINUTE_MS, T(2026, 10, 30, 8, 39))),
    );
    const paused = definitionWithEnabled(quarter, false, NOW);
    // The next run (10:54) falls inside the 15-minute approval window: an
    // approval at 10:55 would fail the server's start check. 11:09 does not.
    expect(paused.schedule).toMatchObject({ startsAt: iso(T(2026, 10, 7, 11, 9)) });
    expect(scheduleProposalOf(proposal("p-q", updatePlan(quarter, paused)))?.kind).toBe("pause");
    const resumed = definitionWithEnabled({ ...quarter, enabled: false }, true, NOW);
    expect(resumed.schedule).toMatchObject({ startsAt: iso(T(2026, 10, 7, 11, 9)) });
    // A one-off run is never moved.
    const once = automation(
      "a-once",
      definition("Once", { kind: "once", runAt: NOW + 5 * MINUTE_MS }),
    );
    expect(definitionWithEnabled(once, false, NOW).schedule).toEqual(once.definition.schedule);
  });

  it("reads anything else as an edit, and cancels as cancels", () => {
    const moved = definition(
      "Triage issues",
      every(T(2026, 10, 7, 12, 30), 2 * HOUR_MS, T(2026, 10, 31, 12, 0)),
    );
    expect(scheduleProposalOf(proposal("p1", updatePlan(a, moved)))?.kind).toBe("edit");
    const pausedAndRenamed = {
      ...definition("Renamed", every(T(2026, 10, 7, 12, 0), 2 * HOUR_MS, T(2026, 10, 31, 12, 0))),
      enabled: false,
    };
    expect(scheduleProposalOf(proposal("p2", updatePlan(a, pausedAndRenamed)))?.kind).toBe("edit");
    expect(scheduleProposalOf(proposal("p3", cancelPlan(a)))).toMatchObject({
      kind: "cancel",
      before: twoHourly,
      after: null,
      expectedRevision: 3,
    });
    expect(
      scheduleProposalOf(
        proposal("p4", {
          kind: "sendMessage",
          threadId: ThreadId.make("t"),
          text: "hi",
          delivery: "queue",
        }),
      ),
    ).toBeNull();
  });

  it("lists pending changes by project, oldest first, dropping ones past their deadline", () => {
    const list = [
      proposal("p-new", createPlan("a-x", definition("X", { kind: "once", runAt: NOW + DAY_MS }))),
      proposal("p-old", cancelPlan(a), { createdAt: NOW - 10 * MINUTE_MS }),
      proposal("p-late", cancelPlan(a), { createdAt: NOW - 20 * MINUTE_MS }),
      proposal(
        "p-hub",
        createPlan(
          "a-hub",
          definition("Hub", { kind: "once", runAt: NOW + DAY_MS }, { projectId: OTHER_PROJECT }),
        ),
      ),
      proposal("p-done", cancelPlan(a), { status: "rejected" }),
    ];
    expect(
      pendingScheduleProposals(list, { projectId: PROJECT, nowMs: NOW }).map((p) => p.id),
    ).toEqual(["p-old", "p-new"]);
    expect(pendingScheduleProposals(list).map((p) => p.id)).toEqual([
      "p-late",
      "p-old",
      "p-hub",
      "p-new",
    ]);
  });

  it("shows the newest pending change on the row", () => {
    const older = proposal("p-older", cancelPlan(a), { createdAt: NOW - 8 * MINUTE_MS });
    const newer = proposal("p-newer", updatePlan(a, definitionWithEnabled(a, false, NOW)), {
      createdAt: NOW - 2 * MINUTE_MS,
    });
    const rows = rowsOf(snapshot({ automations: [a], proposals: [newer, older] }));
    expect(rowById(rows, "a-sched").proposal).toMatchObject({ id: "p-newer", kind: "pause" });
    expect(scheduleRowPresentation(rowById(rows, "a-sched"), NOW).tag).toBe("Pause proposed");
  });
});

describe("lapsed proposals", () => {
  const a = automation("a-sched", twoHourly);
  const edit = definition(
    "Triage issues v2",
    every(T(2026, 10, 7, 12, 0), 2 * HOUR_MS, T(2026, 10, 31, 12, 0)),
  );

  it("keeps a change that expired undecided until something newer is proposed", () => {
    const expired = proposal("p-exp", updatePlan(a, edit), {
      status: "expired",
      createdAt: NOW - HOUR_MS,
    });
    const rows = rowsOf(snapshot({ automations: [a] }), { queueProposals: [expired] });
    const row = rowById(rows, "a-sched");
    expect(row.state).toBe("scheduled");
    expect(row.lapsed).toMatchObject({ id: "p-exp", kind: "edit" });
    expect(scheduleRowPresentation(row, NOW)).toMatchObject({
      tag: "Change expired",
      tagTone: "lapsed",
    });

    const newer = proposal("p-new", updatePlan(a, edit), {
      status: "rejected",
      createdAt: NOW - 10 * MINUTE_MS,
    });
    expect(
      rowById(
        rowsOf(snapshot({ automations: [a] }), { queueProposals: [expired, newer] }),
        "a-sched",
      ).lapsed,
    ).toBeNull();
  });

  it("treats a pending change past its deadline as lapsed", () => {
    const stale = proposal("p-stale", updatePlan(a, edit), { createdAt: NOW - 20 * MINUTE_MS });
    const rows = rowsOf(snapshot({ automations: [a], proposals: [stale] }));
    expect(rowById(rows, "a-sched")).toMatchObject({ proposal: null, lapsed: { id: "p-stale" } });
  });

  it("forgets a dismissed one, a decided one, and a create whose schedule exists", () => {
    const expired = proposal("p-exp", updatePlan(a, edit), { status: "expired" });
    expect(
      rowById(
        rowsOf(snapshot({ automations: [a] }), {
          queueProposals: [expired],
          dismissedLapsed: new Set(["p-exp"]),
        }),
        "a-sched",
      ).lapsed,
    ).toBeNull();
    const rejected = proposal("p-rej", updatePlan(a, edit), { status: "rejected" });
    expect(
      rowById(rowsOf(snapshot({ automations: [a] }), { queueProposals: [rejected] }), "a-sched")
        .lapsed,
    ).toBeNull();
    const createdAnyway = proposal("p-create", createPlan("a-sched", twoHourly), {
      status: "expired",
    });
    expect(
      lapsedScheduleProposals({
        projectId: PROJECT,
        snapshot: snapshot({ automations: [a] }),
        queueProposals: [createdAnyway],
        nowMs: NOW,
      }).size,
    ).toBe(0);
  });

  it("merges the snapshot's and the queue's copies of one proposal, furthest along wins", () => {
    const pending = proposal("p1", updatePlan(a, edit), { createdAt: NOW - 5 * MINUTE_MS });
    const expired = { ...pending, status: "expired" as const, updatedAt: iso(NOW) };
    const rows = rowsOf(snapshot({ automations: [a], proposals: [pending] }), {
      queueProposals: [expired],
    });
    expect(rowById(rows, "a-sched")).toMatchObject({ proposal: null, lapsed: { id: "p1" } });
  });
});

describe("failed proposals", () => {
  const a = automation("a-sched", twoHourly, { revision: 2 });
  const edit = definition(
    "Triage issues v2",
    every(T(2026, 10, 7, 12, 0), 2 * HOUR_MS, T(2026, 10, 31, 12, 0)),
  );
  const validation = (reason: string, detail: string) =>
    `Agent Control plan validation failed (${reason}): ${detail}`;

  it("says why an approved change was not applied, in the dialog's words", () => {
    const failure = (message: string) =>
      scheduleProposalFailure(proposal("p", cancelPlan(a), { failedWith: message }));
    expect(
      failure(validation("schedule-invalid", "The first scheduled run must be in the future.")),
    ).toBe("The first run time passed before approval. Edit the start and save again.");
    expect(
      failure(
        validation("automation-limit", "The project has reached its active automation limit."),
      ),
    ).toBe("This project already has 25 active schedules.");
    expect(failure(validation("automation-stale", "Automation revision changed."))).toBe(
      "The schedule changed since this was proposed. Review it again.",
    );
    expect(failure(validation("automation-stale", "Automation ID already exists."))).toBe(
      "A schedule with this id already exists.",
    );
    expect(failure(validation("automation-unavailable", "Automation is unavailable."))).toBe(
      "This schedule no longer exists.",
    );
    expect(failure(validation("model-unavailable", "Model 'x' is unavailable."))).toBe(
      "The model isn't available on this device any more. Edit the model and save again.",
    );
    expect(failure(validation("invalid-plan", "The requested base ref is invalid."))).toBe(
      "The requested base ref is invalid.",
    );
    expect(failure("The approved Agent Control action failed during execution.")).toBe(
      "The approved Agent Control action failed during execution.",
    );
    expect(failure("")).toBe("The change couldn't be applied.");
    expect(scheduleProposalFailure(proposal("p", cancelPlan(a)))).toBeNull();
  });

  it("lists the newest failed change of each schedule, failed creates included", () => {
    const pastStart = validation(
      "schedule-invalid",
      "The first scheduled run must be in the future.",
    );
    const failedEdit = proposal("p-edit", updatePlan(a, edit), {
      createdAt: NOW - 20 * MINUTE_MS,
      failedWith: validation("automation-stale", "Automation revision changed."),
      failedAt: NOW - 2 * MINUTE_MS,
    });
    const failedCreate = proposal(
      "p-create",
      createPlan("a-new", definition("New", { kind: "once", runAt: NOW - MINUTE_MS })),
      { createdAt: NOW - 10 * MINUTE_MS, failedWith: pastStart, failedAt: NOW - 5 * MINUTE_MS },
    );
    const input = {
      projectId: PROJECT,
      snapshot: snapshot({ automations: [a] }),
      queueProposals: [failedEdit, failedCreate],
      nowMs: NOW,
    };
    const failed = failedScheduleProposals(input);
    expect(failed.map((p) => [p.id, p.kind, p.failure])).toEqual([
      [
        "p-create",
        "create",
        "The first run time passed before approval. Edit the start and save again.",
      ],
      ["p-edit", "edit", "The schedule changed since this was proposed. Review it again."],
    ]);
    // Only what failed since the dialog opened, minus dismissed ones.
    expect(
      failedScheduleProposals({ ...input, sinceMs: NOW - 3 * MINUTE_MS }).map((p) => p.id),
    ).toEqual(["p-edit"]);
    expect(
      failedScheduleProposals({ ...input, dismissedLapsed: new Set(["p-edit"]) }).map((p) => p.id),
    ).toEqual(["p-create"]);
    // Proposing again supersedes the failure; the failed create leaves no row.
    const again = proposal("p-again", updatePlan(a, edit), { createdAt: NOW - MINUTE_MS });
    expect(
      failedScheduleProposals({ ...input, queueProposals: [failedEdit, failedCreate, again] }).map(
        (p) => p.id,
      ),
    ).toEqual(["p-create"]);
    expect(
      rowsOf(input.snapshot, { queueProposals: input.queueProposals }).map((r) => r.id),
    ).toEqual(["a-sched"]);
  });
});

// ── Retry ────────────────────────────────────────────────────────────

describe("scheduleRetryState", () => {
  const a = automation("a-sched", twoHourly, { revision: 2 });
  const state = (entry: AutomationCentreRun, others: AutomationCentreRun[] = [], auto = a) =>
    scheduleRetryState(entry, rowsOf(snapshot({ automations: [auto], runs: [entry, ...others] })));

  it("allows an undispatched rejected, expired, or never-proposed cancelled run", () => {
    expect(state(run("r1", "a-sched", "expired", { revision: 2 }))).toEqual({
      ok: true,
      reason: null,
      block: null,
    });
    expect(state(run("r1", "a-sched", "rejected", { revision: 2 })).ok).toBe(true);
    expect(state(run("r1", "a-sched", "cancelled", { revision: 2, proposalId: null })).ok).toBe(
      true,
    );
  });

  it("refuses failed and in-flight or dispatched runs", () => {
    expect(state(run("r1", "a-sched", "failed", { revision: 2 }))).toEqual({
      ok: false,
      reason:
        "Delivery is uncertain for a failed dispatch. Open its thread or check the device before scheduling new work.",
      block: null,
    });
    expect(state(run("r1", "a-sched", "completed", { revision: 2 })).reason).toBe(
      "Only rejected, expired or cancelled runs can be retried.",
    );
    expect(scheduleRetryState(null, []).reason).toBe("This run is no longer available.");
  });

  it("refuses a run that may have started work, without a hint", () => {
    const started =
      "This run may have started work. Open its thread to inspect or stop it before scheduling another task.";
    expect(state(run("r1", "a-sched", "rejected", { revision: 2, threadIds: ["t1"] }))).toEqual({
      ok: false,
      reason: started,
      block: null,
    });
    expect(
      state(run("r1", "a-sched", "cancelled", { revision: 2 }), [
        run("r2", "a-sched", "pending-approval", { revision: 2 }),
      ]),
    ).toEqual({ ok: false, reason: started, block: null });
  });

  it("says why in a few words: retried, schedule changed, another run in flight", () => {
    const source = run("r1", "a-sched", "expired", { revision: 2, at: NOW - 3 * HOUR_MS });
    expect(
      state(source, [run("r2", "a-sched", "rejected", { revision: 2, retryOf: "r1" })]),
    ).toEqual({
      ok: false,
      reason: "This run was already retried.",
      block: { short: "Retried", long: "This run was already retried.", active: false },
    });
    expect(state(run("r1", "a-sched", "expired", { revision: 1 }))).toEqual({
      ok: false,
      reason: "The schedule changed since this run. Review it before running again.",
      block: {
        short: "Schedule changed since",
        long: "The schedule changed since this run. Review it before running again.",
        active: false,
      },
    });
    expect(
      state(source, [run("r3", "a-sched", "pending-approval", { revision: 2 })]).block,
    ).toEqual({
      short: "Retry opens once the waiting run is decided.",
      long: "Another run of this schedule is already waiting or running.",
      active: true,
    });
    expect(state(source, [run("r3", "a-sched", "executing", { revision: 2 })]).block?.short).toBe(
      "Retry opens once the current run is dispatched.",
    );
  });

  it("refuses runs of a cancelled schedule", () => {
    const gone = automation("a-sched", twoHourly, { revision: 2, cancelled: true });
    expect(state(run("r1", "a-sched", "expired", { revision: 2 }), [], gone)).toEqual({
      ok: false,
      reason: "The schedule was cancelled.",
      block: null,
    });
  });
});

// ── Diff ─────────────────────────────────────────────────────────────

describe("diffScheduleDefinitions", () => {
  const providers: ReadonlyArray<AutomationProviderInfo> = [
    {
      instanceId: "claude",
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-sonnet-5-5",
          name: "Sonnet 5.5",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra high" },
                ],
              },
            ],
          },
        },
        { slug: "claude-opus-5-5", name: "Opus 5.5" },
      ],
    },
  ];
  const diff = (after: AgentControlAutomationDefinition, before = twoHourly) =>
    diffScheduleDefinitions(before, after, { nowMs: NOW, runtimeModeLabel, providers });

  it("says nothing for a start rolled to the same phase", () => {
    expect(
      diff(definitionWithEnabled(automation("a", twoHourly), true, NOW + 5 * HOUR_MS)),
    ).toEqual([]);
  });

  it("lists schedule changes in the lab's words", () => {
    const changed = definition(
      "Triage issues",
      every(T(2026, 10, 7, 12, 30), 6 * HOUR_MS, T(2026, 11, 2, 12, 0)),
    );
    expect(diff(changed)).toEqual([
      { key: "every", label: "Every", before: "2 hours", after: "6 hours" },
      { key: "nextRun", label: "Next run", before: "today 12:00", after: "today 12:30" },
      { key: "ends", label: "Ends", before: "Oct 31", after: "Nov 2" },
    ]);
    const once = definition("Triage issues", { kind: "once", runAt: T(2026, 10, 9, 16, 0) });
    expect(diff(once)).toEqual([
      {
        key: "when",
        label: "When",
        before: "Every 2 h · until Oct 31",
        after: "Once · Oct 9, 16:00",
      },
    ]);
    expect(
      diff(definition("Triage issues", { kind: "once", runAt: T(2026, 10, 9, 17, 0) }), once),
    ).toEqual([
      {
        key: "runsAt",
        label: "Runs at",
        before: "Fri, Oct 9 · 16:00",
        after: "Fri, Oct 9 · 17:00",
      },
    ]);
  });

  it("lists execution changes", () => {
    const base = twoHourly.execution;
    const changed: AgentControlAutomationDefinition = {
      ...twoHourly,
      execution: {
        ...base,
        title: "Triage everything",
        prompt: `${base.prompt} Label them.`,
        modelSelection: { ...base.modelSelection, options: [{ id: "effort", value: "xhigh" }] },
        runtimeMode: "full-access",
        baseRef: "release",
      },
    };
    expect(diff(changed)).toEqual([
      { key: "title", label: "Title", before: "Triage issues", after: "Triage everything" },
      { key: "prompt", label: "Prompt", before: null, after: "+ “Label them.”" },
      {
        key: "effort",
        label: "Effort",
        before: "Sonnet 5.5 · High",
        after: "Sonnet 5.5 · Extra high",
      },
      {
        key: "permissions",
        label: "Permissions",
        before: "Auto-accept edits",
        after: "Full access",
      },
      { key: "branch", label: "Branch", before: "main", after: "release" },
    ]);
    const rewritten: AgentControlAutomationDefinition = {
      ...twoHourly,
      execution: {
        ...base,
        prompt: "Something else.",
        modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
        envMode: "local",
      },
    };
    expect(diff(rewritten)).toEqual([
      { key: "prompt", label: "Prompt", before: null, after: "Rewritten" },
      { key: "model", label: "Model", before: "Sonnet 5.5", after: "Opus 5.5" },
      { key: "runsIn", label: "Runs in", before: "a new worktree", after: "the main checkout" },
    ]);
  });

  it("names models from the provider, else by slug", () => {
    expect(
      scheduleModelLabel(twoHourly.execution.modelSelection, providers, { effort: true }),
    ).toBe("Sonnet 5.5 · High");
    expect(
      scheduleModelLabel(
        { instanceId: CLAUDE, model: "gone-model", options: [{ id: "effort", value: "medium" }] },
        [],
        { effort: true },
      ),
    ).toBe("gone-model · Medium");
    expect(scheduleModelLabel(null)).toBe("No model");
    // Exact slugs only, like the server: an alias is not this model.
    expect(scheduleModelLabel({ instanceId: CLAUDE, model: "sonnet" }, providers)).toBe("sonnet");
  });
});

// ── Drafts ───────────────────────────────────────────────────────────

describe("drafts", () => {
  it("round-trips a definition, trimming and keeping only a worktree's branch", () => {
    const draft = draftFromDefinition(twoHourly, { id: aid("a-sched") });
    expect(draft).toMatchObject({
      id: "a-sched",
      kind: "fixed-interval",
      start: T(2026, 10, 7, 12, 0),
      intervalMs: 2 * HOUR_MS,
      endsAt: T(2026, 10, 31, 12, 0),
      baseRef: "main",
      tokenMode: null,
    });
    expect(definitionFromDraft(draft)).toEqual(twoHourly);
    const local = definitionFromDraft({
      ...draft,
      envMode: "local",
      title: "  Spaced  ",
      tokenMode: "balanced",
    });
    expect(local.execution).not.toHaveProperty("baseRef");
    expect(local.execution).toMatchObject({ title: "Spaced", tokenMode: "balanced" });
  });

  it("keeps a worktree schedule without a branch without one", () => {
    const { baseRef: _none, ...execution } = twoHourly.execution;
    const noRef: AgentControlAutomationDefinition = { ...twoHourly, execution };
    const draft = draftOfLatest(automation("a-sched", noRef), NOW, { defaultBaseRef: "master" });
    expect(draft.baseRef).toBe("");
    const saved = definitionFromDraft({ ...draft, title: "Renamed" });
    expect(saved.execution).not.toHaveProperty("baseRef");
    // A local schedule's draft holds the default branch for a switch to a worktree.
    const local: AgentControlAutomationDefinition = {
      ...twoHourly,
      execution: { ...execution, envMode: "local" },
    };
    const localDraft = draftFromDefinition(local, { defaultBaseRef: "master" });
    expect(localDraft.baseRef).toBe("master");
    expect(definitionFromDraft(localDraft).execution).not.toHaveProperty("baseRef");
    expect(definitionFromDraft({ ...localDraft, envMode: "worktree" }).execution.baseRef).toBe(
      "master",
    );
  });

  it("starts a blank draft tomorrow at 09:00, every 24 hours, for 30 days", () => {
    const draft = blankScheduleDraft({
      projectId: PROJECT,
      nowMs: NOW,
      modelSelection: { instanceId: CLAUDE, model: "claude-sonnet-5-5" },
    });
    expect(draft).toMatchObject({
      id: null,
      kind: "fixed-interval",
      start: T(2026, 10, 8, 9, 0),
      intervalMs: DAY_MS,
      endsAt: T(2026, 10, 8, 9, 0) + 30 * DAY_MS,
      runtimeMode: "auto-accept-edits",
      envMode: "worktree",
      baseRef: "main",
      enabled: true,
    });
  });

  it("rolls a past start forward when drafting from a schedule or a proposal", () => {
    const a = automation(
      "a-sched",
      definition("Old", every(T(2026, 10, 1, 9, 0), DAY_MS, T(2026, 10, 30, 9, 0))),
    );
    expect(draftOfLatest(a, NOW)).toMatchObject({ id: "a-sched", start: T(2026, 10, 8, 9, 0) });
    const lapsed = scheduleProposalOf(
      proposal(
        "p",
        createPlan("a-new", definition("New", { kind: "once", runAt: NOW + HOUR_MS })),
        { status: "expired" },
      ),
    );
    expect(lapsed && draftOfLatest(lapsed, NOW)).toMatchObject({
      id: "a-new",
      kind: "once",
      start: NOW + HOUR_MS,
    });
    const cancel = scheduleProposalOf(proposal("p2", cancelPlan(a)));
    expect(cancel && draftOfLatest(cancel, NOW).title).toBe("Old");
  });

  it("tells a dirty draft by what it would save", () => {
    const draft = draftFromDefinition(twoHourly);
    const key = scheduleDraftKey(draft);
    expect(scheduleDraftKey({ ...draft, title: "Triage issues " })).toBe(key);
    expect(scheduleDraftKey({ ...draft, title: "Triage" })).not.toBe(key);
  });

  it("validates with the checkout's active count", () => {
    const actives = Array.from({ length: 25 }, (_, i) => automation(`a-${i}`, twoHourly));
    const snap = snapshot({ automations: actives });
    expect(activeScheduleCount(snap)).toBe(25);
    const fresh = { ...draftFromDefinition(twoHourly), start: NOW + HOUR_MS };
    expect(
      validateScheduleDraft(fresh, { nowMs: NOW, snapshot: snap, projectName: "ryco" }).errors,
    ).toEqual({
      limit:
        "ryco already has 25 active schedules, the most a project can have. Pause or cancel one first.",
    });
    const editing = { ...fresh, id: aid("a-3") };
    expect(validateScheduleDraft(editing, { nowMs: NOW, snapshot: snap }).ok).toBe(true);
    expect(
      activeScheduleCount(
        snapshot({ automations: [automation("p", twoHourly, { nextRunAt: null })] }),
      ),
    ).toBe(0);
  });

  it("refuses a model option the device's model does not offer", () => {
    const providers: ReadonlyArray<AutomationProviderInfo> = [
      {
        instanceId: "claude",
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [{ slug: "claude-sonnet-5-5", name: "Sonnet 5.5" }],
      },
    ];
    const fresh = { ...draftFromDefinition(twoHourly), start: NOW + HOUR_MS };
    expect(validateScheduleDraft(fresh, { nowMs: NOW, providers }).errors).toEqual({
      model: "Sonnet 5.5 has no effort setting any more. Pick the model again.",
    });
  });
});

describe("editor messages", () => {
  const base = draftFromDefinition(twoHourly);

  it("offers the next occurrence for a repeating start that passed", () => {
    const past = { ...base, start: T(2026, 10, 7, 8, 0) };
    const { errors } = validateScheduleDraft(past, { nowMs: NOW });
    expect(startFix(past, NOW)).toBe(T(2026, 10, 7, 12, 0));
    expect(scheduleDraftMessages(past, errors, { nowMs: NOW })).toEqual([
      {
        key: "start",
        text: "Starts in the past.",
        fix: { label: "Use today 12:00", value: T(2026, 10, 7, 12, 0) },
      },
    ]);
  });

  it("offers the next quarter hour for a once that passed", () => {
    const past = { ...base, kind: "once" as const, start: NOW - HOUR_MS };
    const { errors } = validateScheduleDraft(past, { nowMs: NOW });
    expect(scheduleDraftMessages(past, errors, { nowMs: NOW })).toEqual([
      {
        key: "start",
        text: "That time has passed.",
        fix: { label: "Use today 10:45", value: T(2026, 10, 7, 10, 45) },
      },
    ]);
  });

  it("fixes the interval, the end, and shows the title only once it matters", () => {
    const bad = { ...base, title: "", intervalMs: 5 * MINUTE_MS, endsAt: base.start - HOUR_MS };
    const { errors } = validateScheduleDraft(bad, { nowMs: NOW });
    expect(scheduleDraftMessages(bad, errors, { nowMs: NOW })).toEqual([
      {
        key: "interval",
        text: "Under the 15-minute minimum.",
        fix: { label: "Use 15 minutes", value: 15 * MINUTE_MS },
      },
      {
        key: "end",
        text: "Ends before the first run.",
        fix: { label: "End Oct 14", value: T(2026, 10, 14, 12, 0) },
      },
    ]);
    expect(scheduleDraftMessages(bad, errors, { nowMs: NOW, attempted: true }).at(-1)).toEqual({
      key: "title",
      text: "Give it a short title.",
      fix: null,
    });
    const far = { ...base, endsAt: NOW + 100 * DAY_MS };
    expect(
      scheduleDraftMessages(far, validateScheduleDraft(far, { nowMs: NOW }).errors, { nowMs: NOW }),
    ).toEqual([
      {
        key: "end",
        text: "Ends past the 90-day limit.",
        fix: { label: "End Jan 5, 2027", value: NOW + 90 * DAY_MS },
      },
    ]);
  });
});
