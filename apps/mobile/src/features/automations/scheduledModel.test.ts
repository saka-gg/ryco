import type { AutomationCountsEntry } from "@ryco/client-runtime/state/automations/projectCounts";
import type {
  AgentControlAutomationRunStatus,
  AgentControlProposalView,
  AutomationCentreSnapshot,
  EnvironmentId,
  ProjectId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildScheduledList,
  changedAutomationProjects,
  scheduledPreview,
  type ScheduledCheckoutRef,
} from "./scheduledModel";

const NOW_MS = Date.parse("2026-11-09T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW_MS + minutes * 60_000).toISOString();
const MAC = "env-mac" as EnvironmentId;
const MINI = "env-mini" as EnvironmentId;
const RYCO = "p-ryco" as ProjectId;
const SITE = "p-site" as ProjectId;

const checkouts: ScheduledCheckoutRef[] = [
  { environmentId: MAC, projectId: RYCO, projectName: "ryco", machineLabel: "MacBook" },
  { environmentId: MAC, projectId: SITE, projectName: "site", machineLabel: "MacBook" },
  { environmentId: MINI, projectId: RYCO, projectName: "ryco", machineLabel: "Mac mini" },
];

function definition(projectId: ProjectId, title: string) {
  return {
    execution: {
      projectId,
      title,
      prompt: `Run ${title}`,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
      runtimeMode: "approval-required",
      envMode: "local",
    },
    schedule: {
      kind: "fixed-interval",
      startsAt: at(60),
      intervalMs: 24 * 60 * 60_000,
      endsAt: at(60 * 24 * 20),
    },
    enabled: true,
  };
}

function snapshot(
  projectId: ProjectId,
  automations: ReadonlyArray<{
    readonly id: string;
    readonly run?: AgentControlAutomationRunStatus;
  }>,
): AutomationCentreSnapshot {
  return {
    automations: automations.map((automation) => ({
      automationId: automation.id,
      projectId,
      definition: definition(projectId, automation.id),
      revision: 1,
      enabled: true,
      cancelled: false,
      cancelledAt: null,
      nextRunAt: at(60),
      createdAt: at(-600),
      updatedAt: at(-600),
    })),
    runs: automations.flatMap((automation, index) =>
      automation.run
        ? [
            {
              run: {
                runId: `run-${automation.id}`,
                automationId: automation.id,
                automationRevision: 1,
                projectId,
                scheduledFor: at(-index - 1),
                coalescedOccurrences: 0,
                status: automation.run,
                proposalId: `proposal-${automation.id}`,
                createdAt: at(-index - 1),
                updatedAt: at(-index - 1),
              },
              execution: null,
              threadIds: [],
              unread: false,
              retryOfRunId: null,
            },
          ]
        : [],
    ),
    proposals: [],
    unavailableRecords: 0,
    historyLimit: 50,
  } as unknown as AutomationCentreSnapshot;
}

const ready = (value: AutomationCentreSnapshot): AutomationCountsEntry => ({
  status: "ready",
  snapshot: value,
  counts: { schedules: value.automations.length, waiting: 0 },
  fetchedAt: NOW_MS,
});

const entries = new Map<string, AutomationCountsEntry>([
  [
    `${MAC}\0${RYCO}`,
    ready(snapshot(RYCO, [{ id: "nightly" }, { id: "triage", run: "pending-approval" }])),
  ],
  [`${MAC}\0${SITE}`, ready(snapshot(SITE, [{ id: "deploy check" }]))],
  [`${MINI}\0${RYCO}`, { status: "unavailable", fetchedAt: NOW_MS }],
]);

const all = { environmentId: null, projectId: null };

describe("the phone's Scheduled list", () => {
  it("puts runs waiting for approval first and names their project and machine", () => {
    const list = buildScheduledList({
      checkouts,
      entries,
      queues: new Map(),
      dismissed: new Set(),
      filter: all,
      nowMs: NOW_MS,
    });
    expect(list.read).toBe(true);
    expect(list.unavailable).toBe(1);
    expect(list.waiting.map((row) => row.row.title)).toEqual(["triage"]);
    expect(list.waiting[0]?.place).toBe("ryco · MacBook");
    // The project with a waiting run comes first; inside it, the waiting schedule.
    expect(list.groups.map((group) => group.title)).toEqual(["ryco · MacBook", "site · MacBook"]);
    expect(list.groups[0]?.rows.map((row) => row.item.row.title)).toEqual(["triage", "nightly"]);
  });

  it("follows the Tasks tab's machine and project filter", () => {
    const list = buildScheduledList({
      checkouts,
      entries,
      queues: new Map(),
      dismissed: new Set(),
      filter: { environmentId: MAC, projectId: SITE },
      nowMs: NOW_MS,
    });
    expect(list.rows.map((row) => row.item.row.title)).toEqual(["deploy check"]);
    expect(list.groups[0]?.title).toBe("site");
    expect(list.rows[0]?.place).toBeNull();
    expect(list.unavailable).toBe(0);
  });

  it("previews the soonest schedules, leaving out the waiting runs shown above", () => {
    const list = buildScheduledList({
      checkouts,
      entries,
      queues: new Map(),
      dismissed: new Set(),
      filter: all,
      nowMs: NOW_MS,
    });
    expect(scheduledPreview(list, 1).map((row) => row.item.row.title)).toEqual(["nightly"]);
  });

  it("says a missed run a machine caught up on, until dismissed", () => {
    const missed = {
      proposalId: "proposal-missed",
      status: "pending-user-approval",
      createdAt: at(-1),
      updatedAt: at(-1),
      expiresAt: at(14),
      plan: {
        kind: "automationRun",
        runId: "run-missed",
        automationId: "nightly",
        scheduledFor: at(-120),
        coalescedOccurrences: 2,
        execution: definition(RYCO, "nightly").execution,
      },
    } as unknown as AgentControlProposalView;
    const input = {
      checkouts,
      entries,
      queues: new Map([[MAC, [missed]]]),
      filter: all,
      nowMs: NOW_MS,
    };
    const list = buildScheduledList({ ...input, dismissed: new Set() });
    expect(list.missed.map((item) => [item.machineLabel, item.runs.length])).toEqual([
      ["MacBook", 1],
    ]);
    const dismissed = buildScheduledList({
      ...input,
      dismissed: new Set([missed.proposalId]),
    });
    expect(dismissed.missed).toEqual([]);
  });

  it("re-reads only the projects whose schedule proposals or runs moved", () => {
    const run = {
      proposalId: "p1",
      status: "pending-user-approval",
      updatedAt: at(0),
      plan: {
        kind: "automationRun",
        execution: { projectId: RYCO },
      },
    } as unknown as AgentControlProposalView;
    const other = {
      proposalId: "p2",
      status: "pending-user-approval",
      updatedAt: at(0),
      plan: { kind: "copyProjectToNode" },
    } as unknown as AgentControlProposalView;
    expect([...changedAutomationProjects({ p1: run, p2: other }, undefined)]).toEqual([RYCO]);
    expect([...changedAutomationProjects({ p1: run }, { p1: run })]).toEqual([]);
    expect([
      ...changedAutomationProjects({ p1: { ...run, status: "approved" } }, { p1: run }),
    ]).toEqual([RYCO]);
  });
});
