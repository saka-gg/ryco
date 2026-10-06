/**
 * Test-only: the lab's direction C world on the projects fixtures — ryco on
 * this device and Studio, ryco-hub and an empty scratch folder here — as
 * automation centre snapshots per checkout, plus a stand-in for
 * `useAutomationCentre` that tests install with:
 *
 *   vi.mock("~/components/automations/useAutomationCentre", async () =>
 *     (await import("~/components/automations/dialog/testing/dialogFixtures"))
 *       .dialogAutomationCentreMock);
 *
 * Times are relative to the real clock (the dialog's ticker reads it), on
 * whole minutes so words like "in 1h 58m" are stable within a test.
 */
import type {
  AgentControlAutomation,
  AgentControlAutomationDefinition,
  AgentControlAutomationRunStatus,
  AgentControlProposal,
  AgentControlProposalStatus,
  AutomationCentreRun,
  AutomationCentreSnapshot,
  ProjectId,
  ServerProvider,
} from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { projectCheckoutKey } from "../../../../projectCheckouts.logic";
import {
  HUB_LOCAL,
  LOCAL_ENV,
  RYCO_LOCAL,
  RYCO_STUDIO,
  SCRATCH_LOCAL,
  STUDIO_ENV,
} from "../../../projects/testing/projectFixtures";
import type { AutomationCentreState } from "../../useAutomationCentre";

const MINUTE = 60_000;
const realNow = () => performance.timeOrigin + performance.now();
/** The current minute (real clock), so relative words don't drift mid-test. */
export const fixtureNow = () => Math.floor(realNow() / MINUTE) * MINUTE;
const iso = (minutesFromNow: number) =>
  new Date(fixtureNow() + minutesFromNow * MINUTE).toISOString();

type Env = typeof LOCAL_ENV;

// ── Providers ────────────────────────────────────────────────────────

const EFFORT = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
};

export function fixtureProviders(): ServerProvider[] {
  return [
    {
      instanceId: "claude",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-01T09:00:00.000Z",
      models: [
        {
          slug: "claude-sonnet-5-5",
          name: "Sonnet 5.5",
          capabilities: { optionDescriptors: [EFFORT] },
        },
        {
          slug: "claude-opus-5-5",
          name: "Opus 5.5",
          capabilities: { optionDescriptors: [EFFORT] },
        },
      ],
    },
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-01T09:00:00.000Z",
      models: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
    },
  ] as unknown as ServerProvider[];
}

// ── Schedules, runs, proposals ───────────────────────────────────────

export interface FixtureScheduleInput {
  readonly id: string;
  readonly title: string;
  readonly projectId: ProjectId;
  /** Once (at `nextInMinutes`) or every `everyMinutes`. */
  readonly everyMinutes?: number;
  /** The next run, minutes from now; null: none left (or paused). */
  readonly nextInMinutes: number | null;
  /** Repeating schedules end this many days out. */
  readonly endsInDays?: number;
  readonly prompt?: string;
  readonly envMode?: "local" | "worktree";
  readonly enabled?: boolean;
  readonly revision?: number;
  readonly model?: {
    readonly instanceId: string;
    readonly model: string;
    readonly effort?: string;
  };
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  /** Start at the next run (a proposed schedule), not on an earlier occurrence. */
  readonly startsAtNext?: boolean;
}

export function fixtureDefinition(input: FixtureScheduleInput): AgentControlAutomationDefinition {
  const model = input.model ?? { instanceId: "claude", model: "claude-sonnet-5-5" };
  const next = input.nextInMinutes ?? 60 * 9;
  const schedule = input.everyMinutes
    ? {
        kind: "fixed-interval",
        // A start well in the past on the same phase as the next run.
        startsAt: iso(input.startsAtNext ? next : next - input.everyMinutes * 12),
        intervalMs: input.everyMinutes * MINUTE,
        endsAt: iso(60 * 24 * (input.endsInDays ?? 14)),
      }
    : { kind: "once", runAt: iso(next) };
  return {
    execution: {
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt ?? `Run ${input.title.toLowerCase()} and summarise what changed.`,
      modelSelection: {
        instanceId: model.instanceId,
        model: model.model,
        ...(model.effort ? { options: [{ id: "effort", value: model.effort }] } : {}),
      },
      runtimeMode: input.runtimeMode ?? "approval-required",
      envMode: input.envMode ?? "local",
      ...(input.envMode === "worktree" ? { baseRef: "main" } : {}),
    },
    schedule,
    enabled: input.enabled ?? true,
  } as unknown as AgentControlAutomationDefinition;
}

export function fixtureSchedule(input: FixtureScheduleInput): AgentControlAutomation {
  const enabled = input.enabled ?? true;
  return {
    automationId: input.id,
    principal: { kind: "user" },
    projectId: input.projectId,
    providerInstanceId: input.model?.instanceId ?? "claude",
    definition: fixtureDefinition(input),
    revision: input.revision ?? 1,
    enabled,
    cancelled: false,
    cancelledAt: null,
    nextRunAt: input.nextInMinutes === null || !enabled ? null : iso(input.nextInMinutes),
    createdAt: iso(-60 * 24 * 7),
    updatedAt: iso(-60),
  } as unknown as AgentControlAutomation;
}

export function fixtureRunEntry(input: {
  readonly id: string;
  readonly automationId: string;
  readonly projectId: ProjectId;
  readonly status: AgentControlAutomationRunStatus;
  readonly minutesAgo: number;
  readonly threadIds?: readonly string[];
  readonly proposalId?: string | null;
  readonly failure?: string;
  readonly unread?: boolean;
  readonly coalesced?: number;
  readonly retryOf?: string | null;
  readonly revision?: number;
}): AutomationCentreRun {
  return {
    run: {
      runId: input.id,
      automationId: input.automationId,
      automationRevision: input.revision ?? 1,
      projectId: input.projectId,
      providerInstanceId: "claude",
      scheduledFor: iso(-input.minutesAgo),
      coalescedOccurrences: input.coalesced ?? 0,
      status: input.status,
      proposalId: input.proposalId ?? null,
      safeFailureDetail: input.failure ?? null,
      createdAt: iso(-input.minutesAgo),
      updatedAt: iso(-input.minutesAgo + 1),
      completedAt: null,
    },
    execution: null,
    threadIds: [...(input.threadIds ?? [])],
    unread: input.unread ?? false,
    retryOfRunId: input.retryOf ?? null,
  } as unknown as AutomationCentreRun;
}

function fixtureProposal(input: {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly plan: unknown;
  readonly status?: AgentControlProposalStatus;
  readonly createdMinutesAgo?: number;
  readonly expiresInMinutes?: number;
}): AgentControlProposal {
  const created = -(input.createdMinutesAgo ?? 5);
  return {
    proposalId: input.id,
    requestId: `request-${input.id}`,
    principal: {
      kind: "automation-owner",
      projectId: input.projectId,
      runtimeMode: "approval-required",
      envMode: "local",
    },
    planVersion: 1,
    plan: input.plan,
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: null,
    status: input.status ?? "pending-user-approval",
    createdAt: iso(created),
    updatedAt: iso(created),
    expiresAt: iso(input.expiresInMinutes ?? 13),
    decidedAt: null,
    result: null,
  } as unknown as AgentControlProposal;
}

export function fixtureRunProposal(input: {
  readonly id: string;
  readonly automation: AgentControlAutomation;
  readonly runId: string;
  readonly expiresInMinutes: number;
  readonly coalesced?: number;
}): AgentControlProposal {
  return fixtureProposal({
    id: input.id,
    projectId: input.automation.projectId,
    expiresInMinutes: input.expiresInMinutes,
    createdMinutesAgo: 2,
    plan: {
      kind: "automationRun",
      automationId: input.automation.automationId,
      runId: input.runId,
      automationRevision: input.automation.revision,
      scheduledFor: iso(-2),
      coalescedOccurrences: input.coalesced ?? 0,
      execution: input.automation.definition.execution,
    },
  });
}

export function fixtureCreateProposal(input: {
  readonly id: string;
  readonly automationId: string;
  readonly definition: AgentControlAutomationDefinition;
  readonly status?: AgentControlProposalStatus;
  readonly createdMinutesAgo?: number;
  readonly expiresInMinutes?: number;
}): AgentControlProposal {
  return fixtureProposal({
    ...input,
    projectId: input.definition.execution.projectId,
    plan: {
      kind: "createAutomation",
      automationId: input.automationId,
      definition: input.definition,
    },
  });
}

export function fixtureUpdateProposal(input: {
  readonly id: string;
  readonly automation: AgentControlAutomation;
  readonly after: AgentControlAutomationDefinition;
  readonly status?: AgentControlProposalStatus;
  readonly createdMinutesAgo?: number;
  readonly expiresInMinutes?: number;
}): AgentControlProposal {
  return fixtureProposal({
    ...input,
    projectId: input.automation.projectId,
    plan: {
      kind: "updateAutomation",
      automationId: input.automation.automationId,
      before: {
        revision: input.automation.revision,
        definition: input.automation.definition,
        cancelled: false,
        updatedAt: input.automation.updatedAt,
      },
      after: input.after,
    },
  });
}

function snapshotOf(input: {
  readonly automations?: readonly AgentControlAutomation[];
  readonly runs?: readonly AutomationCentreRun[];
  readonly proposals?: readonly AgentControlProposal[];
}): AutomationCentreSnapshot {
  return {
    automations: [...(input.automations ?? [])],
    runs: [...(input.runs ?? [])],
    proposals: [...(input.proposals ?? [])],
    unavailableRecords: 0,
    historyLimit: 50,
  } as unknown as AutomationCentreSnapshot;
}

// ── The world ────────────────────────────────────────────────────────

const TRIAGE_PROMPT =
  "Look at GitHub issues opened since the last run. Label each one bug, feature or question, link duplicates, and ask for a reproduction where one is missing. Don't close anything. End with a one-paragraph summary.";

/** ryco on this device: a run waiting, a change proposed, one starting, one once. */
export function rycoLocalSnapshot(): AutomationCentreSnapshot {
  const p = RYCO_LOCAL;
  const triage = fixtureSchedule({
    id: "auto-triage",
    title: "Triage new issues",
    projectId: p,
    everyMinutes: 120,
    nextInMinutes: 118,
    prompt: TRIAGE_PROMPT,
    model: { instanceId: "codex", model: "gpt-5.5" },
  });
  const changelog = fixtureSchedule({
    id: "auto-changelog",
    title: "Update the changelog",
    projectId: p,
    everyMinutes: 60 * 24 * 7,
    nextInMinutes: 60 * 24 * 2 + 5,
    envMode: "worktree",
    runtimeMode: "auto-accept-edits",
    model: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "low" },
    prompt: "Collect the PRs merged to main since the last release tag.",
  });
  const changelogAfter: AgentControlAutomationDefinition = {
    ...changelog.definition,
    execution: {
      ...changelog.definition.execution,
      prompt: `${changelog.definition.execution.prompt} Skip PRs labelled internal.`,
    },
  };
  const watch = fixtureSchedule({
    id: "auto-ci",
    title: "Watch main CI for flakes",
    projectId: p,
    everyMinutes: 30,
    nextInMinutes: 28,
  });
  const draft = fixtureSchedule({
    id: "auto-draft",
    title: "Draft 0.14 release notes",
    projectId: p,
    nextInMinutes: 318,
  });
  const runs: AutomationCentreRun[] = [
    fixtureRunEntry({
      id: "run-due",
      automationId: "auto-triage",
      projectId: p,
      status: "pending-approval",
      minutesAgo: 2,
      proposalId: "proposal-due",
    }),
    fixtureRunEntry({
      id: "run-t1",
      automationId: "auto-triage",
      projectId: p,
      status: "completed",
      minutesAgo: 122,
      threadIds: ["thread-relay"],
      unread: true,
    }),
    fixtureRunEntry({
      id: "run-t2",
      automationId: "auto-triage",
      projectId: p,
      status: "expired",
      minutesAgo: 242,
      coalesced: 4,
    }),
    fixtureRunEntry({
      id: "run-t3",
      automationId: "auto-triage",
      projectId: p,
      status: "rejected",
      minutesAgo: 362,
    }),
    fixtureRunEntry({
      id: "run-t4",
      automationId: "auto-triage",
      projectId: p,
      status: "failed",
      minutesAgo: 482,
      failure: "Codex app-server exited before the thread started (exit code 1).",
    }),
    ...[5, 6, 7, 8, 9].map((n) =>
      fixtureRunEntry({
        id: `run-t${n}`,
        automationId: "auto-triage",
        projectId: p,
        status: "completed",
        minutesAgo: 120 * n + 2,
        threadIds: ["thread-projects"],
      }),
    ),
    fixtureRunEntry({
      id: "run-ci",
      automationId: "auto-ci",
      projectId: p,
      status: "executing",
      minutesAgo: 1,
    }),
    ...[1, 2, 3].map((n) =>
      fixtureRunEntry({
        id: `run-c${n}`,
        automationId: "auto-changelog",
        projectId: p,
        status: "completed",
        minutesAgo: 60 * 24 * 7 * n,
        threadIds: ["thread-projects"],
      }),
    ),
  ];
  return snapshotOf({
    automations: [triage, changelog, watch, draft],
    runs,
    proposals: [
      fixtureRunProposal({
        id: "proposal-due",
        automation: triage,
        runId: "run-due",
        expiresInMinutes: 13,
      }),
      fixtureUpdateProposal({
        id: "proposal-change",
        automation: changelog,
        after: changelogAfter,
      }),
    ],
  });
}

/** ryco on Studio: a nightly check and a paused suite whose model is gone. */
export function rycoStudioSnapshot(): AutomationCentreSnapshot {
  const p = RYCO_STUDIO;
  return snapshotOf({
    automations: [
      fixtureSchedule({
        id: "auto-deps",
        title: "Nightly dependency check",
        projectId: p,
        everyMinutes: 60 * 24,
        nextInMinutes: 60 * 16,
      }),
      fixtureSchedule({
        id: "auto-e2e",
        title: "Nightly e2e suite",
        projectId: p,
        everyMinutes: 60 * 24,
        nextInMinutes: 60 * 14,
        enabled: false,
        model: { instanceId: "claude", model: "claude-opus-4" },
      }),
    ],
    runs: [
      fixtureRunEntry({
        id: "run-e2e",
        automationId: "auto-e2e",
        projectId: p,
        status: "failed",
        minutesAgo: 60 * 10,
        failure: "The worktree could not be created.",
      }),
    ],
  });
}

/** ryco-hub here: a proposed new schedule, a pause proposed, three missed runs → one approval. */
export function hubSnapshot(): AutomationCentreSnapshot {
  const p = HUB_LOCAL;
  const cert = fixtureSchedule({
    id: "auto-cert",
    title: "Check staging certificates",
    projectId: p,
    everyMinutes: 60 * 12,
    nextInMinutes: 60 * 10 + 18,
  });
  const relay = fixtureSchedule({
    id: "auto-relay",
    title: "Summarise relay logs",
    projectId: p,
    everyMinutes: 60,
    nextInMinutes: 33,
    model: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
  });
  const rotate = fixtureDefinition({
    id: "auto-rotate",
    title: "Rotate staging relay keys",
    projectId: p,
    everyMinutes: 60 * 24 * 7,
    nextInMinutes: 60 * 24 * 3,
    startsAtNext: true,
  });
  return snapshotOf({
    automations: [cert, relay],
    runs: [
      fixtureRunEntry({
        id: "run-relay-due",
        automationId: "auto-relay",
        projectId: p,
        status: "pending-approval",
        minutesAgo: 2,
        proposalId: "proposal-relay",
        coalesced: 3,
      }),
    ],
    proposals: [
      fixtureRunProposal({
        id: "proposal-relay",
        automation: relay,
        runId: "run-relay-due",
        expiresInMinutes: 9,
        coalesced: 3,
      }),
      fixtureCreateProposal({
        id: "proposal-rotate",
        automationId: "auto-rotate",
        definition: rotate,
        createdMinutesAgo: 8,
      }),
      fixtureUpdateProposal({
        id: "proposal-pause",
        automation: cert,
        after: { ...cert.definition, enabled: false },
        createdMinutesAgo: 4,
      }),
    ],
  });
}

/** An expired, undecided "create" in the device's Agent Control queue. */
export function lapsedCreateProposal(projectId: ProjectId = SCRATCH_LOCAL): AgentControlProposal {
  return fixtureCreateProposal({
    id: "proposal-lapsed",
    automationId: "auto-cleanup",
    definition: fixtureDefinition({
      id: "auto-cleanup",
      title: "Weekly cleanup",
      projectId,
      everyMinutes: 60 * 24,
      nextInMinutes: 60 * 20,
      startsAtNext: true,
    }),
    status: "expired",
    createdMinutesAgo: 20,
    expiresInMinutes: -2,
  });
}

/** `count` active schedules (the limit is 25 per checkout). */
export function fullSnapshot(projectId: ProjectId, count = 25): AutomationCentreSnapshot {
  return snapshotOf({
    automations: Array.from({ length: count }, (_, index) =>
      fixtureSchedule({
        id: `auto-full-${index}`,
        title: `Check ${String(index + 1).padStart(2, "0")}`,
        projectId,
        everyMinutes: 60 * 24,
        nextInMinutes: 60 + index * 20,
      }),
    ),
  });
}

/** `snapshot` with one run decided: no longer waiting, its proposal gone. */
export function withRunDecided(
  snapshot: AutomationCentreSnapshot,
  runId: string,
  status: AgentControlAutomationRunStatus,
): AutomationCentreSnapshot {
  const decided = snapshot.runs.find((entry) => entry.run.runId === runId);
  const proposalId = decided?.run.proposalId ?? null;
  return snapshotOf({
    automations: snapshot.automations,
    runs: snapshot.runs.map((entry) =>
      entry.run.runId === runId ? { ...entry, run: { ...entry.run, status } } : entry,
    ),
    proposals: snapshot.proposals.filter((proposal) => proposal.proposalId !== proposalId),
  });
}

/** One of the snapshot's proposals as the device's Agent Control queue holds it, in `status`. */
export function queuedProposal(
  snapshot: AutomationCentreSnapshot,
  proposalId: string,
  status: AgentControlProposalStatus,
  failure?: string,
): AgentControlProposal {
  const proposal = snapshot.proposals.find((candidate) => candidate.proposalId === proposalId);
  if (!proposal) throw new Error(`No proposal ${proposalId} in the snapshot.`);
  return {
    ...proposal,
    status,
    decidedAt: status === "pending-user-approval" ? null : iso(0),
    result:
      status === "failed"
        ? {
            outcome: "failed",
            error: { code: "execution-failed", message: failure ?? "", retryable: false },
            failedAt: iso(0),
          }
        : null,
  } as unknown as AgentControlProposal;
}

// ── The stand-in for useAutomationCentre ─────────────────────────────

type CentreCommand = Parameters<AutomationCentreState["command"]>[0];

/* Readers re-read when a test publishes a change, as a live centre would. */
const fixtureListeners = new Set<() => void>();
let fixtureVersion = 0;
const subscribeFixture = (listener: () => void) => {
  fixtureListeners.add(listener);
  return () => {
    fixtureListeners.delete(listener);
  };
};
const readFixtureVersion = () => fixtureVersion;

/** Scripted automation centres, by checkout; commands and decisions recorded. */
export const dialogCentreFixture = {
  snapshots: new Map<string, AutomationCentreSnapshot>(),
  providers: new Map<string, ServerProvider[]>(),
  disabledReason: null as string | null,
  commandResult: true,
  commands: [] as Array<{ readonly environmentId: string; readonly input: CentreCommand }>,
  decisions: [] as Array<{
    readonly environmentId: string;
    readonly proposalId: string;
    readonly decision: string;
  }>,
  /** Runs as a decision is recorded, before it resolves (a test's server). */
  afterDecide: null as
    | null
    | ((environmentId: string, proposalId: string, decision: string) => void),
  set(environmentId: Env, projectId: ProjectId, snapshot: AutomationCentreSnapshot) {
    this.snapshots.set(projectCheckoutKey(environmentId, projectId), snapshot);
  },
  /** Set a checkout's snapshot and let every reader re-read it. */
  update(environmentId: Env, projectId: ProjectId, snapshot: AutomationCentreSnapshot) {
    this.set(environmentId, projectId, snapshot);
    this.publish();
  },
  publish() {
    fixtureVersion += 1;
    for (const listener of fixtureListeners) listener();
  },
  reset() {
    this.snapshots = new Map();
    this.providers = new Map([
      [LOCAL_ENV, fixtureProviders()],
      [STUDIO_ENV, fixtureProviders()],
    ]);
    this.disabledReason = null;
    this.commandResult = true;
    this.commands = [];
    this.decisions = [];
    this.afterDecide = null;
    this.set(LOCAL_ENV, RYCO_LOCAL, rycoLocalSnapshot());
    this.set(STUDIO_ENV, RYCO_STUDIO, rycoStudioSnapshot());
    this.set(LOCAL_ENV, HUB_LOCAL, hubSnapshot());
    this.set(LOCAL_ENV, SCRATCH_LOCAL, snapshotOf({}));
  },
};
dialogCentreFixture.reset();

export const dialogAutomationCentreMock = {
  useAutomationCentre(environmentId: Env, projectId: ProjectId): AutomationCentreState {
    useSyncExternalStore(subscribeFixture, readFixtureVersion);
    return {
      snapshot:
        dialogCentreFixture.snapshots.get(projectCheckoutKey(environmentId, projectId)) ?? null,
      providers: dialogCentreFixture.providers.get(environmentId) ?? [],
      error: null,
      busy: false,
      disabledReason: dialogCentreFixture.disabledReason,
      command: async (input) => {
        dialogCentreFixture.commands.push({ environmentId, input });
        return dialogCentreFixture.commandResult;
      },
      decide: async (proposalId, decision) => {
        dialogCentreFixture.decisions.push({ environmentId, proposalId, decision });
        dialogCentreFixture.afterDecide?.(environmentId, proposalId, decision);
      },
      refresh: () => undefined,
    };
  },
};
