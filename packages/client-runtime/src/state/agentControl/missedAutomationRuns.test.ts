import { describe, expect, it } from "vite-plus/test";
import type { AgentControlProposal, AgentControlProposalStatus } from "@ryco/contracts";

import {
  MISSED_AUTOMATION_RUN_LATENESS_MS,
  MISSED_AUTOMATION_RUN_NOTICE_WINDOW_MS,
  collectMissedAutomationRuns,
  missedAutomationRunOf,
} from "./missedAutomationRuns.ts";

const NOW = Date.parse("2026-10-07T09:00:00.000Z");
const DUE = "2026-10-07T03:00:00.000Z";

const runProposal = (input: {
  readonly id: string;
  readonly scheduledFor?: string;
  readonly createdAt?: string;
  readonly status?: AgentControlProposalStatus;
  readonly coalesced?: number;
  readonly kind?: string;
}) =>
  ({
    proposalId: input.id,
    status: input.status ?? "pending-user-approval",
    createdAt: input.createdAt ?? "2026-10-07T08:59:00.000Z",
    plan: {
      kind: input.kind ?? "automationRun",
      automationId: `automation-${input.id}`,
      runId: `run-${input.id}`,
      scheduledFor: input.scheduledFor ?? DUE,
      coalescedOccurrences: input.coalesced ?? 0,
      execution: { projectId: "project-1", title: `Schedule ${input.id}` },
    },
  }) as unknown as AgentControlProposal;

describe("missedAutomationRunOf", () => {
  it("reads a catch-up run proposed long after its time", () => {
    expect(missedAutomationRunOf(runProposal({ id: "a", coalesced: 2 }), NOW)).toEqual({
      proposalId: "a",
      runId: "run-a",
      automationId: "automation-a",
      projectId: "project-1",
      title: "Schedule a",
      scheduledFor: DUE,
      laterOccurrences: 2,
      proposedAt: "2026-10-07T08:59:00.000Z",
      state: "waiting",
    });
  });

  it("ignores a run a regular scheduler tick claimed", () => {
    const onTime = new Date(Date.parse(DUE) + 30_000).toISOString();
    const justLate = new Date(Date.parse(DUE) + MISSED_AUTOMATION_RUN_LATENESS_MS).toISOString();
    expect(missedAutomationRunOf(runProposal({ id: "a", createdAt: onTime }), NOW)).toBeNull();
    expect(missedAutomationRunOf(runProposal({ id: "b", createdAt: justLate }), NOW)).not.toBe(
      null,
    );
  });

  it("reports waiting and expired catch-ups only", () => {
    expect(missedAutomationRunOf(runProposal({ id: "a", status: "expired" }), NOW)?.state).toBe(
      "expired",
    );
    for (const status of ["approved", "executing", "completed", "rejected", "cancelled"] as const)
      expect(missedAutomationRunOf(runProposal({ id: status, status }), NOW)).toBeNull();
  });

  it("ignores other proposals and catch-ups past the notice window", () => {
    expect(missedAutomationRunOf(runProposal({ id: "a", kind: "createAutomation" }), NOW)).toBe(
      null,
    );
    const old = new Date(NOW - MISSED_AUTOMATION_RUN_NOTICE_WINDOW_MS - 1).toISOString();
    expect(
      missedAutomationRunOf(runProposal({ id: "b", createdAt: old, scheduledFor: old }), NOW),
    ).toBeNull();
  });
});

describe("collectMissedAutomationRuns", () => {
  it("lists missed runs, the earliest due first", () => {
    const runs = collectMissedAutomationRuns(
      [
        runProposal({ id: "late", scheduledFor: "2026-10-07T05:00:00.000Z" }),
        runProposal({ id: "on-time", createdAt: "2026-10-07T03:00:20.000Z" }),
        runProposal({ id: "early", scheduledFor: "2026-10-07T01:00:00.000Z" }),
      ],
      NOW,
    );
    expect(runs.map((run) => run.proposalId)).toEqual(["early", "late"]);
  });
});
