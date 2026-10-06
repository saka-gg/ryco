import {
  EnvironmentId,
  ProjectId,
  type AgentControlAutomationRunStatus,
  type AgentControlProposalStatus,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkoutAutomationCounts,
  createAutomationCountsLoader,
  projectAutomationCounts,
  type AutomationCheckoutRef,
} from "./automationProjectCounts.logic";

const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");
const local: AutomationCheckoutRef = { environmentId: LOCAL, projectId: ProjectId.make("p-local") };
const studio: AutomationCheckoutRef = {
  environmentId: STUDIO,
  projectId: ProjectId.make("p-studio"),
};

const NOW_MS = Date.parse("2026-10-06T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW_MS + minutes * 60_000).toISOString();

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
    schedule: { kind: "once", runAt: at(60) },
    enabled: true,
  };
}

/* The parts of each record the rows read; the rest is irrelevant here. */
function snapshot(input: {
  readonly projectId?: ProjectId;
  readonly automations?: ReadonlyArray<{ readonly id: string; readonly cancelled?: boolean }>;
  readonly runs?: ReadonlyArray<{
    readonly automationId: string;
    readonly status: AgentControlAutomationRunStatus;
  }>;
  readonly creates?: ReadonlyArray<{
    readonly automationId: string;
    readonly status?: AgentControlProposalStatus;
    readonly expiresInMinutes?: number;
  }>;
}): AutomationCentreSnapshot {
  const projectId = input.projectId ?? local.projectId;
  return {
    automations: (input.automations ?? []).map((automation) => ({
      automationId: automation.id,
      projectId,
      definition: definition(projectId, automation.id),
      revision: 1,
      enabled: true,
      cancelled: automation.cancelled ?? false,
      cancelledAt: null,
      nextRunAt: at(60),
      createdAt: at(-600),
      updatedAt: at(-600),
    })),
    runs: (input.runs ?? []).map((run, index) => ({
      run: {
        runId: `run-${index}`,
        automationId: run.automationId,
        automationRevision: 1,
        projectId,
        scheduledFor: at(-index),
        coalescedOccurrences: 0,
        status: run.status,
        proposalId: null,
        createdAt: at(-index),
        updatedAt: at(-index),
      },
      execution: null,
      threadIds: [],
      unread: false,
      retryOfRunId: null,
    })),
    proposals: (input.creates ?? []).map((create) => ({
      proposalId: `proposal-${create.automationId}`,
      status: create.status ?? "pending-user-approval",
      plan: {
        kind: "createAutomation",
        automationId: create.automationId,
        definition: definition(projectId, create.automationId),
      },
      createdAt: at(-5),
      updatedAt: at(-5),
      expiresAt: at(create.expiresInMinutes ?? 10),
    })),
    unavailableRecords: 0,
    historyLimit: 50,
  } as unknown as AutomationCentreSnapshot;
}

describe("checkoutAutomationCounts", () => {
  it("counts the rows the dialog lists and the runs waiting for approval", () => {
    expect(
      checkoutAutomationCounts({
        projectId: local.projectId,
        nowMs: NOW_MS,
        snapshot: snapshot({
          automations: [{ id: "a" }, { id: "b" }, { id: "gone", cancelled: true }],
          runs: [
            { automationId: "a", status: "pending-approval" },
            { automationId: "a", status: "completed" },
            { automationId: "b", status: "pending-approval" },
            { automationId: "b", status: "executing" },
          ],
          creates: [
            { automationId: "new" },
            // Already a schedule; lapsed (past its deadline); decided: none counts.
            { automationId: "a" },
            { automationId: "late", expiresInMinutes: -1 },
            { automationId: "decided", status: "approved" },
          ],
        }),
      }),
    ).toEqual({ schedules: 3, waiting: 2 });
  });

  it("leaves out another project's schedules", () => {
    expect(
      checkoutAutomationCounts({
        projectId: studio.projectId,
        nowMs: NOW_MS,
        snapshot: snapshot({ automations: [{ id: "a" }] }),
      }),
    ).toEqual({ schedules: 0, waiting: 0 });
  });
});

describe("projectAutomationCounts", () => {
  it("sums the checkouts that answered and is null before any did", () => {
    const entries = new Map([
      [
        `${LOCAL}\0p-local`,
        { status: "ready" as const, counts: { schedules: 2, waiting: 1 }, fetchedAt: 0 },
      ],
      [`${STUDIO}\0p-studio`, { status: "unavailable" as const, fetchedAt: 0 }],
    ]);
    expect(projectAutomationCounts([local, studio], entries)).toEqual({
      schedules: 2,
      waiting: 1,
    });
    expect(projectAutomationCounts([studio], entries)).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("createAutomationCountsLoader", () => {
  it("reads each checkout once, caches the answer and re-reads stale ones", async () => {
    let now = 1_000;
    const reads: string[] = [];
    const loader = createAutomationCountsLoader({
      now: () => now,
      readSnapshot: (checkout) => {
        reads.push(checkout.environmentId);
        if (checkout.environmentId === STUDIO) return null;
        return Promise.resolve(
          snapshot({
            automations: [{ id: "a" }],
            runs: [{ automationId: "a", status: "pending-approval" }],
          }),
        );
      },
    });
    let changes = 0;
    loader.subscribe(() => changes++);

    loader.request([local, studio]);
    expect(loader.getState().loading).toBe(true);
    // No reader: unavailable at once, no read in flight for it.
    expect(loader.getState().entries.get(`${STUDIO}\0p-studio`)?.status).toBe("unavailable");
    // A second ask while the first read is in flight starts nothing new.
    loader.request([local]);
    await Promise.resolve();
    expect(loader.getState().loading).toBe(false);
    expect(projectAutomationCounts([local], loader.getState().entries)).toEqual({
      schedules: 1,
      waiting: 1,
    });
    expect(reads).toEqual([LOCAL, STUDIO]);
    expect(changes).toBe(2);

    now += 30_000;
    loader.request([local, studio]);
    expect(reads).toHaveLength(2);
    now += 31_000;
    loader.request([local], { maxAgeMs: 60_000 });
    expect(reads).toEqual([LOCAL, STUDIO, LOCAL]);
  });

  it("ignores answers that arrive after cancel, and reads again on the next ask", async () => {
    const first = deferred<AutomationCentreSnapshot>();
    const second = deferred<AutomationCentreSnapshot>();
    const pending = [first, second];
    const loader = createAutomationCountsLoader({
      readSnapshot: () => pending.shift()!.promise,
    });
    loader.request([local]);
    loader.cancel();
    expect(loader.getState().loading).toBe(false);
    first.resolve(snapshot({ automations: [{ id: "stale" }] }));
    await Promise.resolve();
    expect(loader.getState().entries.size).toBe(0);

    loader.request([local]);
    second.reject(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.getState().entries.get(`${LOCAL}\0p-local`)?.status).toBe("unavailable");
  });
});
