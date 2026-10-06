/**
 * Test-only: automation centre snapshots for the projects page fixtures, and
 * a stand-in for `useAutomationCentre` that tests install with:
 *
 *   vi.mock("~/components/automations/useAutomationCentre", async () =>
 *     (await import("~/components/projects/testing/automationFixtures")).automationCentreMock);
 */
import type {
  AgentControlAutomation,
  AgentControlAutomationRunStatus,
  AutomationCentreRun,
  AutomationCentreSnapshot,
} from "@ryco/contracts";

import type { AutomationCentreState } from "../../automations/useAutomationCentre";
import { LOCAL_ENV, RYCO_LOCAL } from "./projectFixtures";

/* Countdowns read the real clock (the shared ticker captures it at load), so
   schedule times are relative to it, not to the tests' frozen Date. */
const realNow = () => performance.timeOrigin + performance.now();
const iso = (minutesFromNow: number) => new Date(realNow() + minutesFromNow * 60_000).toISOString();

export function fixtureAutomation(input: {
  readonly id: string;
  readonly title: string;
  readonly everyMinutes?: number;
  readonly nextInMinutes: number | null;
  readonly envMode?: "local" | "worktree";
  readonly enabled?: boolean;
  readonly projectId?: string;
}): AgentControlAutomation {
  const enabled = input.enabled ?? true;
  return {
    automationId: input.id,
    principal: { kind: "user" },
    projectId: input.projectId ?? RYCO_LOCAL,
    providerInstanceId: "claude",
    definition: {
      execution: {
        projectId: input.projectId ?? RYCO_LOCAL,
        title: input.title,
        prompt: `Run ${input.title}`,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
        runtimeMode: "approval-required",
        envMode: input.envMode ?? "local",
        ...(input.envMode === "worktree" ? { baseRef: "main" } : {}),
      },
      schedule: {
        kind: "fixed-interval",
        startsAt: iso(-60 * 24 * 7),
        intervalMs: (input.everyMinutes ?? 30) * 60_000,
        endsAt: "2026-10-31T00:00:00.000Z",
      },
      enabled,
    },
    revision: 1,
    enabled,
    cancelled: false,
    cancelledAt: null,
    nextRunAt: input.nextInMinutes === null ? null : iso(input.nextInMinutes),
    createdAt: iso(-60 * 24 * 7),
    updatedAt: iso(-60),
  } as unknown as AgentControlAutomation;
}

export function fixtureRun(input: {
  readonly id: string;
  readonly automationId: string;
  readonly status: AgentControlAutomationRunStatus;
  readonly minutesAgo: number;
  readonly threadIds?: readonly string[];
  readonly proposalId?: string | null;
  readonly failure?: string;
}): AutomationCentreRun {
  return {
    run: {
      runId: input.id,
      automationId: input.automationId,
      automationRevision: 1,
      projectId: RYCO_LOCAL,
      providerInstanceId: "claude",
      scheduledFor: iso(-input.minutesAgo),
      coalescedOccurrences: 0,
      status: input.status,
      proposalId: input.proposalId ?? null,
      safeFailureDetail: input.failure ?? null,
      createdAt: iso(-input.minutesAgo),
      updatedAt: iso(-input.minutesAgo),
      completedAt: null,
    },
    execution: null,
    threadIds: [...(input.threadIds ?? [])],
    unread: false,
    retryOfRunId: null,
  } as unknown as AutomationCentreRun;
}

/** The ryco checkout on this device: one due run, one nightly, one paused. */
export function defaultLocalAutomationSnapshot(): AutomationCentreSnapshot {
  return {
    automations: [
      fixtureAutomation({ id: "auto-triage", title: "Triage new issues", nextInMinutes: 0 }),
      fixtureAutomation({
        id: "auto-nightly",
        title: "Nightly dependency check",
        everyMinutes: 60 * 24,
        nextInMinutes: 60 * 9 + 12,
        envMode: "worktree",
      }),
      fixtureAutomation({
        id: "auto-logs",
        title: "Summarise relay logs",
        nextInMinutes: null,
        enabled: false,
      }),
    ],
    runs: [
      fixtureRun({
        id: "run-due",
        automationId: "auto-triage",
        status: "pending-approval",
        minutesAgo: 0,
        proposalId: "proposal-due",
      }),
      fixtureRun({
        id: "run-nightly",
        automationId: "auto-nightly",
        status: "completed",
        minutesAgo: 60 * 15,
        threadIds: ["thread-relay"],
      }),
    ],
    proposals: [],
    unavailableRecords: 0,
    historyLimit: 50,
  } as unknown as AutomationCentreSnapshot;
}

/** Scripted automation centre: snapshots by environment, decisions recorded. */
export const automationCentreFixture = {
  snapshots: new Map<string, AutomationCentreSnapshot>(),
  decisions: [] as Array<{
    readonly environmentId: string;
    readonly proposalId: string;
    readonly decision: string;
  }>,
  commands: [] as Array<{ readonly environmentId: string; readonly input: unknown }>,
  reset() {
    this.snapshots = new Map([[LOCAL_ENV, defaultLocalAutomationSnapshot()]]);
    this.decisions = [];
    this.commands = [];
  },
};
automationCentreFixture.reset();

export const automationCentreMock = {
  useAutomationCentre(environmentId: string): AutomationCentreState {
    return {
      snapshot: automationCentreFixture.snapshots.get(environmentId) ?? null,
      providers: [],
      error: null,
      busy: false,
      disabledReason: null,
      command: async (input) => {
        automationCentreFixture.commands.push({ environmentId, input });
        return true;
      },
      decide: async (proposalId, decision) => {
        automationCentreFixture.decisions.push({ environmentId, proposalId, decision });
      },
      refresh: () => undefined,
    };
  },
};
