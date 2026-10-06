import {
  AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT,
  AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX,
  AgentControlAutomationId,
  AgentControlAutomationRunId,
  AgentControlProposalId,
  AgentControlRequestId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AgentControlActionPlan,
  type AgentControlAutomationDefinition,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type AgentControlProposalStreamEvent,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { deriveScheduleRows, useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  client: null as object | null,
  listeners: new Set<() => void>(),
  stream: null as null | {
    readonly listener: (event: AgentControlProposalStreamEvent) => void;
    readonly onError: () => void;
  },
  listProposals: vi.fn(),
}));
vi.mock("../../../environments/runtime", () => ({
  readEnvironmentConnection: () => (runtime.client ? { client: runtime.client } : null),
  subscribeEnvironmentConnections: (listener: () => void) => {
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  },
}));
vi.mock("../../../environmentApi", () => ({
  readEnvironmentApiForConnection: () => ({
    agentControl: {
      subscribeProposals: (
        listener: (event: AgentControlProposalStreamEvent) => void,
        options: { readonly onError: () => void },
      ) => {
        runtime.stream = { listener, onError: options.onError };
        return () => {
          runtime.stream = null;
        };
      },
      listProposals: runtime.listProposals,
    },
  }),
}));

import {
  SCHEDULE_PROPOSAL_HISTORY_LIMIT,
  absorbScheduleProposals,
  resetScheduleProposalHistoryForTests,
  retainScheduleProposalHistory,
  useScheduleProposalHistoryStore,
} from "./scheduleProposalHistory";
import { retainAgentControlProposalSync } from "./useAutomationProposalSync";
import { checkoutQueueProposals } from "./useLapsedScheduleProposals";

const ENV = EnvironmentId.make("env-local");
const PROJECT = ProjectId.make("ryco");
const MINUTE = 60_000;
const START = Date.parse("2026-10-06T08:00:00.000Z");
const NOW = START + 12 * 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const definition: AgentControlAutomationDefinition = {
  execution: {
    projectId: PROJECT,
    title: "Weekly digest",
    prompt: "Summarise the week.",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5-5" },
    runtimeMode: "approval-required",
    envMode: "local",
  },
  schedule: { kind: "once", runAt: iso(NOW + 24 * 60 * MINUTE) },
  enabled: true,
};

function proposal(
  id: string,
  plan: AgentControlActionPlan,
  status: AgentControlProposalStatus,
  createdAtMs: number,
): AgentControlProposal {
  return {
    proposalId: AgentControlProposalId.make(id),
    requestId: AgentControlRequestId.make(`request-${id}`),
    principal: {
      kind: "automation-owner",
      projectId: PROJECT,
      runtimeMode: "approval-required",
      envMode: "local",
    },
    planVersion: 1,
    plan,
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Weekly digest",
    status,
    createdAt: iso(createdAtMs),
    updatedAt: iso(createdAtMs + 15 * MINUTE),
    expiresAt: iso(createdAtMs + 15 * MINUTE),
    decidedAt: null,
    result: null,
  };
}

const createPlan = (automationId: string): AgentControlActionPlan => ({
  kind: "createAutomation",
  automationId: AgentControlAutomationId.make(automationId),
  definition,
});
const runPlan = (index: number): AgentControlActionPlan => ({
  kind: "automationRun",
  automationId: AgentControlAutomationId.make("auto-busy"),
  runId: AgentControlAutomationRunId.make(`run-${index}`),
  automationRevision: 1,
  scheduledFor: iso(START + index * 15 * MINUTE),
  coalescedOccurrences: 0,
  execution: definition.execution,
});

const emptySnapshot: AutomationCentreSnapshot = {
  automations: [],
  runs: [],
  proposals: [],
  unavailableRecords: 0,
  historyLimit: 50,
};

const lapsedTitles = (proposals: readonly AgentControlProposal[]) =>
  deriveScheduleRows({
    projectId: PROJECT,
    snapshot: emptySnapshot,
    queueProposals: proposals,
    nowMs: NOW,
  })
    .filter((row) => row.state === "lapsed")
    .map((row) => row.title);

afterEach(async () => {
  runtime.client = null;
  runtime.listeners.clear();
  runtime.stream = null;
  runtime.listProposals.mockReset();
  useAgentControlStore.getState().clearEnvironment(ENV);
  resetScheduleProposalHistoryForTests();
  await flush();
});

describe("absorbScheduleProposals", () => {
  it("keeps the newest finished schedule proposal per automation", () => {
    const older = proposal("p-old", createPlan("auto-a"), "expired", START);
    const newer = proposal("p-new", createPlan("auto-a"), "rejected", START + MINUTE);
    const pending = proposal("p-pending", createPlan("auto-b"), "pending-user-approval", START);
    const run = proposal("p-run", runPlan(0), "completed", START);

    const history = absorbScheduleProposals({}, [older, pending, run]);
    expect(Object.values(history)).toEqual([older]);
    expect(absorbScheduleProposals(history, [newer])).toEqual({ "auto-a": newer });
    // An older document, the same one again, or nothing schedule-related changes nothing.
    const latest = absorbScheduleProposals(history, [newer]);
    expect(absorbScheduleProposals(latest, [older, newer, pending, run])).toBe(latest);
  });

  it("lets the least recently updated automations go past the limit", () => {
    const proposals = Array.from({ length: SCHEDULE_PROPOSAL_HISTORY_LIMIT + 1 }, (_, index) =>
      proposal(`p-${index}`, createPlan(`auto-${index}`), "expired", START + index * MINUTE),
    );
    const history = absorbScheduleProposals({}, proposals);
    expect(Object.keys(history)).toHaveLength(SCHEDULE_PROPOSAL_HISTORY_LIMIT);
    expect(history["auto-0"]).toBeUndefined();
    expect(history[`auto-${SCHEDULE_PROPOSAL_HISTORY_LIMIT}`]).toBeDefined();
  });
});

describe("schedule proposal history through the queue sync", () => {
  it("keeps an expired proposal lapsed after the queue let it go", async () => {
    runtime.client = {};
    const release = retainAgentControlProposalSync(ENV);
    const expired = proposal("p-lapsed", createPlan("auto-lapsed"), "expired", START);
    runtime.stream!.listener({
      version: 1,
      type: "snapshot",
      queue: { revision: 1, active: [], recent: [expired] },
    });
    // Five hours of one 15-minute schedule: every run proposal finishes.
    for (let index = 0; index <= AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT; index++) {
      runtime.stream!.listener({
        version: 1,
        type: "proposal",
        revision: index + 2,
        proposal: proposal(
          `p-run-${index}`,
          runPlan(index),
          "completed",
          START + (index + 1) * 15 * MINUTE,
        ),
      });
    }
    const queue = useAgentControlStore.getState().queueByEnvironmentId[ENV];
    expect(queue?.proposalsById["p-lapsed"]).toBeUndefined();
    // The queue alone has lost it …
    expect(lapsedTitles(checkoutQueueProposals(queue, undefined))).toEqual([]);
    // … the session history has not.
    const history = useScheduleProposalHistoryStore.getState().byEnvironment[ENV];
    expect(lapsedTitles(checkoutQueueProposals(queue, history))).toEqual(["Weekly digest"]);

    // A refused queue clears what the server no longer stands behind.
    runtime.stream!.onError();
    expect(useScheduleProposalHistoryStore.getState().byEnvironment[ENV]).toBeUndefined();
    release();
    await flush();
  });

  it("merges without duplicates and keeps identities", () => {
    useAgentControlStore.getState().applyStreamEvent(ENV, {
      version: 1,
      type: "snapshot",
      queue: {
        revision: 1,
        active: [],
        recent: [proposal("p-lapsed", createPlan("auto-lapsed"), "expired", START)],
      },
    });
    const queue = useAgentControlStore.getState().queueByEnvironmentId[ENV];
    const history = absorbScheduleProposals({}, Object.values(queue!.proposalsById));
    const merged = checkoutQueueProposals(queue, history);
    expect(merged.map((p) => p.proposalId)).toEqual(["p-lapsed"]);
    expect(checkoutQueueProposals(queue, history)).toBe(merged);
  });
});

describe("retainScheduleProposalHistory", () => {
  it("reads the longest recent list once per connection", async () => {
    const expired = proposal("p-old", createPlan("auto-old"), "expired", START);
    runtime.listProposals.mockResolvedValue({ revision: 1, active: [], recent: [expired] });
    const release = retainScheduleProposalHistory(ENV);
    expect(runtime.listProposals).not.toHaveBeenCalled();

    runtime.client = {};
    for (const listener of runtime.listeners) listener();
    await flush();
    expect(runtime.listProposals).toHaveBeenCalledExactlyOnceWith({
      recentLimit: AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX,
    });
    await vi.waitFor(() =>
      expect(useScheduleProposalHistoryStore.getState().byEnvironment[ENV]).toEqual({
        "auto-old": expired,
      }),
    );

    // Held again on the same connection: no second read.
    const again = retainScheduleProposalHistory(ENV);
    expect(runtime.listProposals).toHaveBeenCalledTimes(1);
    again();
    release();
    expect(runtime.listeners.size).toBe(0);
  });

  it("tries again on a later hold when the read failed", async () => {
    runtime.client = {};
    runtime.listProposals.mockRejectedValueOnce(new Error("refused"));
    retainScheduleProposalHistory(ENV)();
    await vi.waitFor(() => expect(runtime.listProposals).toHaveBeenCalledTimes(1));
    await flush();
    runtime.listProposals.mockResolvedValue({ revision: 1, active: [], recent: [] });
    retainScheduleProposalHistory(ENV)();
    expect(runtime.listProposals).toHaveBeenCalledTimes(2);
  });
});
