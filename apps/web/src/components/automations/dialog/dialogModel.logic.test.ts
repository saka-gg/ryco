process.env.TZ = "Europe/Berlin";

import {
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  EnvironmentId,
  ProjectId,
  type AgentControlAutomation,
  type AgentControlAutomationRunStatus,
  type AgentControlProposal,
  type AutomationCentreRun,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { deriveScheduleRows } from "@ryco/client-runtime/state/agentControl";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalOutcome,
  deriveDialogRows,
  dialogLimit,
  dialogListSections,
  dialogQueueLine,
  dialogRowKey,
  flattenDialogRows,
  liveProjectCounts,
  newScheduleCheckout,
  resolveDialogRequest,
  resolveDialogSelection,
  type DialogCheckoutInput,
  type DialogQueueInput,
} from "./dialogModel.logic";
import {
  detailVerb,
  lapsedWords,
  plural,
  proposalNote,
  queueChangesLabel,
  queueRunsLabel,
  runAriaLabel,
  runHistoryText,
  scheduleWhenLine,
} from "./dialogWords";

const NOW_MS = Date.parse("2026-10-07T08:42:00.000Z"); // Wed 10:42 in Berlin
const at = (minutes: number) => new Date(NOW_MS + minutes * 60_000).toISOString();
const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");
const P_LOCAL = ProjectId.make("p-local");
const P_STUDIO = ProjectId.make("p-studio");

function automation(input: {
  readonly id: string;
  readonly title: string;
  readonly projectId?: ProjectId;
  readonly everyMinutes?: number;
  readonly nextInMinutes: number | null;
  readonly enabled?: boolean;
}): AgentControlAutomation {
  const projectId = input.projectId ?? P_LOCAL;
  const every = input.everyMinutes ?? 120;
  const next = input.nextInMinutes ?? 60;
  return {
    automationId: input.id,
    principal: { kind: "user" },
    projectId,
    providerInstanceId: "claude",
    definition: {
      execution: {
        projectId,
        title: input.title,
        prompt: "Do it.",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: {
        kind: "fixed-interval",
        startsAt: at(next - every * 5),
        intervalMs: every * 60_000,
        endsAt: "2026-10-20T08:42:00.000Z",
      },
      enabled: input.enabled ?? true,
    },
    revision: 1,
    enabled: input.enabled ?? true,
    cancelled: false,
    cancelledAt: null,
    nextRunAt: input.nextInMinutes === null ? null : at(input.nextInMinutes),
    createdAt: at(-60 * 24),
    updatedAt: at(-60),
  } as unknown as AgentControlAutomation;
}

function run(input: {
  readonly id: string;
  readonly automationId: string;
  readonly status: AgentControlAutomationRunStatus;
  readonly minutesAgo: number;
  readonly proposalId?: string;
  readonly projectId?: ProjectId;
  readonly coalesced?: number;
  readonly threadIds?: readonly string[];
  readonly unread?: boolean;
  readonly retryOf?: string;
  readonly failure?: string;
}): AutomationCentreRun {
  return {
    run: {
      runId: input.id,
      automationId: input.automationId,
      automationRevision: 1,
      projectId: input.projectId ?? P_LOCAL,
      providerInstanceId: "claude",
      scheduledFor: at(-input.minutesAgo),
      coalescedOccurrences: input.coalesced ?? 0,
      status: input.status,
      proposalId: input.proposalId ?? null,
      safeFailureDetail: input.failure ?? null,
      createdAt: at(-input.minutesAgo),
      updatedAt: at(-input.minutesAgo),
      completedAt: null,
    },
    execution: null,
    threadIds: [...(input.threadIds ?? [])],
    unread: input.unread ?? false,
    retryOfRunId: input.retryOf ?? null,
  } as unknown as AutomationCentreRun;
}

function proposal(input: {
  readonly id: string;
  readonly plan: unknown;
  readonly projectId?: ProjectId;
  readonly createdMinutesAgo: number;
  readonly expiresInMinutes: number;
  readonly status?: string;
}): AgentControlProposal {
  return {
    proposalId: input.id,
    requestId: `r-${input.id}`,
    principal: { kind: "automation-owner", projectId: input.projectId ?? P_LOCAL },
    planVersion: 1,
    plan: input.plan,
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: null,
    status: input.status ?? "pending-user-approval",
    createdAt: at(-input.createdMinutesAgo),
    updatedAt: at(-input.createdMinutesAgo),
    expiresAt: at(input.expiresInMinutes),
    decidedAt: null,
    result: null,
  } as unknown as AgentControlProposal;
}

function runProposal(id: string, automationId: string, runId: string, expiresIn: number) {
  return proposal({
    id,
    createdMinutesAgo: 1,
    expiresInMinutes: expiresIn,
    plan: { kind: "automationRun", automationId, runId },
  });
}

function editProposal(id: string, a: AgentControlAutomation, createdMinutesAgo: number) {
  return proposal({
    id,
    createdMinutesAgo,
    expiresInMinutes: 30,
    plan: {
      kind: "updateAutomation",
      automationId: a.automationId,
      before: { revision: 1, definition: a.definition, cancelled: false, updatedAt: a.updatedAt },
      after: {
        ...a.definition,
        execution: { ...a.definition.execution, prompt: "Do it. And more." },
      },
    },
  });
}

function snapshot(input: Partial<AutomationCentreSnapshot>): AutomationCentreSnapshot {
  return {
    automations: [],
    runs: [],
    proposals: [],
    unavailableRecords: 0,
    historyLimit: 50,
    ...input,
  } as AutomationCentreSnapshot;
}

const checkout = (
  environmentId: EnvironmentId,
  projectId: ProjectId,
  deviceLabel: string,
  snap: AutomationCentreSnapshot | null,
): DialogCheckoutInput => ({
  key: `${environmentId}:${projectId}`,
  environmentId,
  projectId,
  deviceLabel,
  snapshot: snap,
});

const NO_QUEUES = new Map<string, DialogQueueInput>();

describe("the dialog's rows", () => {
  const triage = automation({ id: "a-triage", title: "Triage", nextInMinutes: 118 });
  const changelog = automation({ id: "a-changelog", title: "Changelog", nextInMinutes: 60 });
  const relay = automation({ id: "a-relay", title: "Relay", nextInMinutes: 20 });
  const deps = automation({
    id: "a-deps",
    title: "Deps",
    projectId: P_STUDIO,
    nextInMinutes: 300,
  });
  const local = checkout(
    LOCAL,
    P_LOCAL,
    "This device",
    snapshot({
      automations: [triage, changelog, relay],
      runs: [
        run({
          id: "r-due",
          automationId: "a-triage",
          status: "pending-approval",
          minutesAgo: 2,
          proposalId: "p-due",
        }),
        run({
          id: "r-relay",
          automationId: "a-relay",
          status: "pending-approval",
          minutesAgo: 1,
          proposalId: "p-relay",
        }),
      ],
      proposals: [
        runProposal("p-due", "a-triage", "r-due", 13),
        runProposal("p-relay", "a-relay", "r-relay", 5),
        editProposal("p-change", changelog, 4),
      ],
    }),
  );
  const studio = checkout(STUDIO, P_STUDIO, "Studio", snapshot({ automations: [deps] }));

  it("lists each device's rows under its heading, this device first", () => {
    const groups = deriveDialogRows([local, studio], NO_QUEUES, NOW_MS);
    const sections = dialogListSections(groups);
    expect(
      sections.flatMap((section) =>
        [`# ${section.checkoutKey}`].concat(section.rows.map((item) => item.row.title)),
      ),
    ).toEqual([`# ${local.key}`, "Changelog", "Relay", "Triage", `# ${studio.key}`, "Deps"]);
    const rows = flattenDialogRows(groups);
    expect(rows[0]!.key).toBe(dialogRowKey(LOCAL, changelog.automationId));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("has no headings on one device, and nothing for a device not read yet", () => {
    expect(
      dialogListSections(deriveDialogRows([local], NO_QUEUES, NOW_MS)).map((s) => s.checkoutKey),
    ).toEqual([null]);
    const unread = deriveDialogRows(
      [local, checkout(STUDIO, P_STUDIO, "Studio", null)],
      NO_QUEUES,
      NOW_MS,
    );
    expect(unread[1]!.rows).toEqual([]);
    expect(dialogListSections(unread).map((s) => s.checkoutKey)).toEqual([local.key]);
  });

  it("keeps the chosen row, else picks the run expiring first, else the first row", () => {
    const rows = flattenDialogRows(deriveDialogRows([local, studio], NO_QUEUES, NOW_MS));
    const key = (id: string) => rows.find((row) => row.row.id === id)!.key;
    expect(resolveDialogSelection(rows, key("a-deps"))).toBe(key("a-deps"));
    expect(resolveDialogSelection(rows, "gone")).toBe(key("a-relay"));
    const quiet = flattenDialogRows(deriveDialogRows([studio], NO_QUEUES, NOW_MS));
    expect(resolveDialogSelection(quiet, null)).toBe(quiet[0]!.key);
    expect(resolveDialogSelection([], null)).toBeNull();
  });

  it("says what waits in the header, leaving the selected schedule to its detail", () => {
    const rows = flattenDialogRows(deriveDialogRows([local, studio], NO_QUEUES, NOW_MS));
    const key = (id: string) => rows.find((row) => row.row.id === id)!.key;
    const none = dialogQueueLine(rows, null);
    expect(none.runs).toMatchObject({ count: 2, title: "Relay" });
    expect(none.runs!.first.key).toBe(key("a-relay"));
    expect(none.changes).toMatchObject({ count: 1 });
    expect(none.changes!.first.key).toBe(key("a-changelog"));
    const relaySelected = dialogQueueLine(rows, key("a-relay"));
    expect(relaySelected.runs).toMatchObject({ count: 1, title: "Triage" });
    const changelogSelected = dialogQueueLine(rows, key("a-changelog"));
    expect(changelogSelected.changes).toBeNull();
  });

  it("counts the switcher's schedules and waiting runs off the live rows", () => {
    const rows = flattenDialogRows(deriveDialogRows([local, studio], NO_QUEUES, NOW_MS));
    expect(liveProjectCounts(rows)).toEqual({ schedules: 4, waiting: 2 });
  });

  it("leaves lapsed proposals out of the switcher's count", () => {
    const lapsed = proposal({
      id: "p-lapsed",
      createdMinutesAgo: 30,
      expiresInMinutes: -15,
      status: "expired",
      plan: {
        kind: "createAutomation",
        automationId: "a-new",
        definition: {
          ...triage.definition,
          execution: { ...triage.definition.execution, title: "New one" },
        },
      },
    });
    const queues = new Map<string, DialogQueueInput>([
      [studio.key, { queueProposals: [], dismissed: new Set() }],
      [local.key, { queueProposals: [lapsed], dismissed: new Set() }],
    ]);
    const rows = flattenDialogRows(deriveDialogRows([local], queues, NOW_MS));
    expect(rows.map((row) => row.row.state)).toContain("lapsed");
    expect(liveProjectCounts(rows).schedules).toBe(3);
  });
});

describe("an open request", () => {
  const a = automation({ id: "a-1", title: "A", nextInMinutes: 30 });
  const b = automation({ id: "a-2", title: "B", projectId: P_STUDIO, nextInMinutes: 30 });
  const rows = flattenDialogRows(
    deriveDialogRows(
      [
        checkout(LOCAL, P_LOCAL, "This device", snapshot({ automations: [a] })),
        checkout(STUDIO, P_STUDIO, "Studio", snapshot({ automations: [b] })),
      ],
      NO_QUEUES,
      NOW_MS,
    ),
  );
  const request = (
    automationId: string | null,
    mode: "view" | "edit" | "new",
    environmentId: EnvironmentId | null = null,
  ) => ({ automationId, mode, environmentId });

  it("selects the named schedule, and opens its editor for an edit", () => {
    expect(
      resolveDialogRequest({ request: request("a-2", "view"), rows, loading: false }),
    ).toMatchObject({
      kind: "select",
      edit: false,
      item: { key: dialogRowKey(STUDIO, b.automationId) },
    });
    expect(
      resolveDialogRequest({ request: request("a-1", "edit"), rows, loading: false }),
    ).toMatchObject({
      kind: "select",
      edit: true,
    });
  });

  it("matches only the named device's schedule", () => {
    expect(
      resolveDialogRequest({ request: request("a-2", "view", LOCAL), rows, loading: false }),
    ).toEqual({
      kind: "drop",
    });
  });

  it("waits while the rows load, then drops a schedule that isn't there", () => {
    expect(resolveDialogRequest({ request: request("gone", "view"), rows, loading: true })).toEqual(
      { kind: "wait" },
    );
    expect(
      resolveDialogRequest({ request: request("gone", "view"), rows, loading: false }),
    ).toEqual({ kind: "drop" });
    expect(resolveDialogRequest({ request: request(null, "view"), rows, loading: true })).toEqual({
      kind: "drop",
    });
    expect(resolveDialogRequest({ request: request(null, "new"), rows, loading: true })).toEqual({
      kind: "wait",
    });
    expect(resolveDialogRequest({ request: request(null, "new"), rows, loading: false })).toEqual({
      kind: "new",
    });
  });
});

describe("the active-schedule limit", () => {
  const many = (n: number, projectId: ProjectId) =>
    snapshot({
      automations: Array.from({ length: n }, (_, i) =>
        automation({ id: `a-${projectId}-${i}`, title: `S${i}`, projectId, nextInMinutes: 30 + i }),
      ),
    });
  const PER = AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT;

  it("is said once it is within five, and full at the limit", () => {
    expect(
      dialogLimit([checkout(LOCAL, P_LOCAL, "This device", many(PER - 6, P_LOCAL))]).show,
    ).toBe(false);
    const near = dialogLimit([checkout(LOCAL, P_LOCAL, "This device", many(PER - 5, P_LOCAL))]);
    expect(near).toMatchObject({ show: true, full: false, allFull: false, active: PER - 5 });
    const full = dialogLimit([checkout(LOCAL, P_LOCAL, "This device", many(PER, P_LOCAL))]);
    expect(full).toMatchObject({ show: true, full: true, allFull: true, openCheckoutKeys: [] });
  });

  it("applies per device: a new schedule goes where there is room", () => {
    const local = checkout(LOCAL, P_LOCAL, "This device", many(PER, P_LOCAL));
    const studio = checkout(STUDIO, P_STUDIO, "Studio", many(3, P_STUDIO));
    const limit = dialogLimit([local, studio]);
    expect(limit).toMatchObject({ full: true, allFull: false, deviceLabel: "This device" });
    expect(newScheduleCheckout(limit, null)).toBe(studio.key);
    expect(newScheduleCheckout(limit, studio.key)).toBe(studio.key);
    // A device asked for by name keeps the draft even when full: the editor says why.
    expect(newScheduleCheckout(limit, local.key)).toBe(local.key);
    expect(newScheduleCheckout(dialogLimit([local]), null)).toBeNull();
    expect(newScheduleCheckout(dialogLimit([local]), local.key)).toBe(local.key);
    // Paused or finished schedules don't count.
    const paused = snapshot({
      automations: [automation({ id: "a-p", title: "P", nextInMinutes: 5, enabled: false })],
    });
    expect(dialogLimit([checkout(LOCAL, P_LOCAL, "This device", paused)]).active).toBe(0);
  });

  it("counts only devices it could read: one loading or out of reach has no room", () => {
    const local = checkout(LOCAL, P_LOCAL, "This device", many(PER, P_LOCAL));
    const away = checkout(STUDIO, P_STUDIO, "Studio", null);
    const limit = dialogLimit([local, away]);
    expect(limit).toMatchObject({
      allFull: true,
      openCheckoutKeys: [],
      readableCheckoutKeys: [local.key],
    });
    expect(newScheduleCheckout(limit, null)).toBeNull();
    expect(newScheduleCheckout(limit, away.key)).toBeNull();
    const nothingRead = dialogLimit([away]);
    expect(nothingRead).toMatchObject({ allFull: false, show: false, openCheckoutKeys: [] });
    expect(newScheduleCheckout(nothingRead, away.key)).toBeNull();
  });
});

describe("what became of an approval", () => {
  const queued = (status: string, failure?: string) =>
    ({
      ...proposal({ id: "p-1", plan: {}, createdMinutesAgo: 1, expiresInMinutes: 10, status }),
      ...(failure === undefined
        ? {}
        : {
            result: {
              outcome: "failed",
              error: { code: "execution-failed", message: failure, retryable: false },
              failedAt: at(0),
            },
          }),
    }) as AgentControlProposal;

  it("waits while the queue hasn't moved", () => {
    expect(approvalOutcome(undefined, "run")).toEqual({ kind: "pending" });
    expect(approvalOutcome(queued("pending-user-approval"), "change")).toEqual({
      kind: "pending",
    });
  });

  it("says a run's approval expired before it went through, and nothing else", () => {
    expect(approvalOutcome(queued("expired"), "run")).toEqual({
      kind: "notice",
      tone: "warning",
      title: "That approval expired before it went through.",
    });
    for (const status of ["approved", "executing", "completed", "failed", "rejected"])
      expect(approvalOutcome(queued(status), "run")).toEqual({ kind: "settled" });
  });

  it("says why a change couldn't be applied once it has been tried", () => {
    expect(approvalOutcome(queued("approved"), "change")).toEqual({ kind: "pending" });
    expect(approvalOutcome(queued("executing"), "change")).toEqual({ kind: "pending" });
    expect(
      approvalOutcome(queued("failed", "The schedule changed since this was proposed."), "change"),
    ).toEqual({
      kind: "notice",
      tone: "error",
      title: "The schedule changed since this was proposed.",
    });
    expect(approvalOutcome(queued("failed"), "change")).toEqual({
      kind: "notice",
      tone: "error",
      title: "The change couldn't be applied.",
    });
    expect(approvalOutcome(queued("completed"), "change")).toEqual({ kind: "settled" });
    // An expired change shows as "Proposal expired" on its row.
    expect(approvalOutcome(queued("expired"), "change")).toEqual({ kind: "settled" });
  });
});

describe("the dialog's words", () => {
  it("counts and verbs", () => {
    expect(plural(1, "run")).toBe("1 run");
    expect(plural(1200, "run")).toBe("1,200 runs");
    expect(plural(4, "missed", "missed")).toBe("4 missed");
    expect(detailVerb("scheduled")).toBe("Runs");
    expect(detailVerb("awaiting-approval")).toBe("Runs");
    expect(detailVerb("paused")).toBe("Would run");
    expect(detailVerb("pending-create")).toBe("Would run");
    expect(detailVerb("finished")).toBe("Ran");
  });

  it("says what a proposal leaves running", () => {
    const a = automation({ id: "a", title: "A", nextInMinutes: 118 });
    const rows = deriveScheduleRows({
      projectId: P_LOCAL,
      snapshot: snapshot({ automations: [a], proposals: [editProposal("p", a, 2)] }),
      nowMs: NOW_MS,
    });
    const edit = rows[0]!.proposal!;
    expect(proposalNote(edit, a, NOW_MS)).toBe(
      "The current schedule keeps running until you approve.",
    );
    expect(proposalNote({ ...edit, kind: "pause" }, a, NOW_MS)).toBe(
      "Still runs today 12:40 unless you approve.",
    );
    expect(proposalNote({ ...edit, kind: "resume" }, a, NOW_MS)).toBe(
      "Approving resumes it; the first run is today 12:40.",
    );
    expect(proposalNote({ ...edit, kind: "cancel" }, a, NOW_MS)).toBe(
      "Cancelling is final. The run history stays.",
    );
  });

  it("says a lapsed proposal plainly", () => {
    expect(lapsedWords("create")).toEqual({
      title: "This new schedule expired undecided",
      body: "Nothing was created. Propose it again to ask for approval.",
      dismiss: "Remove",
    });
    expect(lapsedWords("pause")).toEqual({
      title: "Your pause expired undecided",
      body: "Nothing changed. Propose it again to ask for approval.",
      dismiss: "Dismiss",
    });
  });

  it("names the header's queue for screen readers", () => {
    expect(queueRunsLabel(1, "Triage", "10:55")).toBe(
      "Triage: run waiting for approval, expires 10:55. Show it",
    );
    expect(queueRunsLabel(3, "Triage", "10:55")).toBe(
      "3 runs waiting for approval, the first expires 10:55. Show it",
    );
    expect(queueChangesLabel(1)).toBe("1 change waiting for your approval. Show it");
    expect(queueChangesLabel(2)).toBe("2 changes waiting for your approval. Show the first");
  });

  it("says when: next run, the last one, paused, ended, and a proposed first run", () => {
    const a = automation({ id: "a", title: "A", nextInMinutes: 118 });
    const [row] = deriveScheduleRows({
      projectId: P_LOCAL,
      snapshot: snapshot({ automations: [a] }),
      nowMs: NOW_MS,
    });
    expect(scheduleWhenLine(row!, NOW_MS)).toEqual({
      kind: "next",
      at: "today 12:40",
      nextRunAt: NOW_MS + 118 * 60_000,
      tail: "155 more runs until Oct 20",
    });
    const paused = automation({ id: "p", title: "P", nextInMinutes: null, enabled: false });
    const [pausedRow] = deriveScheduleRows({
      projectId: P_LOCAL,
      snapshot: snapshot({ automations: [paused] }),
      nowMs: NOW_MS,
    });
    expect(scheduleWhenLine(pausedRow!, NOW_MS)).toEqual({
      kind: "quiet",
      text: "No runs while paused. It ends Oct 20.",
    });
    const ended = automation({ id: "e", title: "E", nextInMinutes: null });
    const [endedRow] = deriveScheduleRows({
      projectId: P_LOCAL,
      snapshot: snapshot({ automations: [ended] }),
      nowMs: NOW_MS,
    });
    expect(scheduleWhenLine(endedRow!, NOW_MS)).toMatchObject({
      kind: "quiet",
      text: "No runs left. It ended Oct 20.",
    });
  });

  it("says what a finished run did", () => {
    const base = { automationId: "a", minutesAgo: 60 } as const;
    expect(
      runHistoryText(run({ ...base, id: "1", status: "completed", threadIds: ["t"] }), "Fix it"),
    ).toEqual({
      missed: null,
      retry: false,
      text: "Fix it",
      tone: "",
    });
    expect(
      runHistoryText(run({ ...base, id: "2", status: "completed", retryOf: "1" }), null),
    ).toMatchObject({ retry: true, text: "Thread started" });
    expect(
      runHistoryText(run({ ...base, id: "3", status: "expired", coalesced: 4 }), null),
    ).toEqual({
      missed: "4 missed → 1 · ",
      retry: false,
      text: "Not approved within 15 min",
      tone: "",
    });
    expect(runHistoryText(run({ ...base, id: "4", status: "rejected" }), null).text).toBe(
      "Rejected before it started",
    );
    expect(runHistoryText(run({ ...base, id: "5", status: "failed" }), null)).toMatchObject({
      text: "Couldn't start.",
      tone: "err",
    });
    expect(runHistoryText(run({ ...base, id: "6", status: "cancelled" }), null).text).toBe(
      "Cancelled",
    );
    expect(runAriaLabel(run({ ...base, id: "7", status: "completed", unread: true }), NOW_MS)).toBe(
      "Dispatched, unread, today 09:42",
    );
  });
});
