import { describe, expect, it } from "vite-plus/test";
import {
  AgentControlProposalId,
  MessageId,
  TurnId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type AgentControlProposalStreamEvent,
} from "@ryco/contracts";

import {
  AGENT_CONTROL_CLIENT_HISTORY_LIMIT,
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  applyAgentControlStreamEvent,
  selectActiveAgentControlProposals,
  selectAgentControlProposalsForThread,
  selectRecentAgentControlProposals,
  selectAgentControlExternalActivity,
  selectAgentControlThreadActivity,
} from "./logic.ts";

const callerThreadId = ThreadId.make("thread-caller");

function makeProposal(
  id: string,
  overrides: Partial<AgentControlProposal> = {},
): AgentControlProposal {
  return {
    proposalId: AgentControlProposalId.make(id),
    requestId: AgentControlRequestId.make(`request-${id}`),
    principal: {
      kind: "provider-session",
      threadId: callerThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    planVersion: 1,
    plan: {
      kind: "sendMessage",
      threadId: ThreadId.make("thread-target"),
      text: "Continue with the migration.",
      delivery: "queue",
    },
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Send a message to thread-target",
    status: "pending-user-approval",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T01:00:00.000Z",
    decidedAt: null,
    result: null,
    ...overrides,
  };
}

function snapshotEvent(input: {
  revision: number;
  active?: AgentControlProposal[];
  recent?: AgentControlProposal[];
}): AgentControlProposalStreamEvent {
  return {
    version: 1,
    type: "snapshot",
    queue: {
      revision: input.revision,
      active: input.active ?? [],
      recent: input.recent ?? [],
    },
  };
}

function proposalEvent(
  revision: number,
  proposal: AgentControlProposal,
): AgentControlProposalStreamEvent {
  return { version: 1, type: "proposal", revision, proposal };
}

describe("applyAgentControlStreamEvent", () => {
  it("hydrates from a snapshot and applies later events", () => {
    const pending = makeProposal("p1");
    const hydrated = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 5, active: [pending] }),
    );
    expect(hydrated.hydrated).toBe(true);
    expect(hydrated.revision).toBe(5);
    expect(selectActiveAgentControlProposals(hydrated)).toHaveLength(1);

    const approved = makeProposal("p1", {
      status: "approved",
      decidedAt: "2026-08-17T00:05:00.000Z",
      updatedAt: "2026-08-17T00:05:00.000Z",
    });
    const next = applyAgentControlStreamEvent(hydrated, proposalEvent(6, approved));
    expect(next.revision).toBe(6);
    expect(next.proposalsById[approved.proposalId]?.status).toBe("approved");
  });

  it("ignores change events before hydration", () => {
    const state = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      proposalEvent(3, makeProposal("early")),
    );
    expect(state).toBe(EMPTY_AGENT_CONTROL_QUEUE_STATE);
  });

  it("treats replays and backward status documents as no-ops", () => {
    const approved = makeProposal("p1", {
      status: "approved",
      decidedAt: "2026-08-17T00:05:00.000Z",
    });
    const hydrated = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 10, active: [approved] }),
    );

    // A replay of the same document keeps the state identity stable.
    const replayed = applyAgentControlStreamEvent(hydrated, proposalEvent(9, approved));
    expect(replayed).toBe(hydrated);

    // A reordered stale document (earlier status) loses the upsert.
    const backward = applyAgentControlStreamEvent(
      hydrated,
      proposalEvent(11, makeProposal("p1", { status: "pending-user-approval" })),
    );
    expect(backward).toBe(hydrated);
  });

  it("applies an event for another proposal even when delivered out of order", () => {
    const hydrated = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 10, active: [makeProposal("p1")] }),
    );
    // Concurrent publishers can invert revision order across proposals;
    // dedupe is per proposal, so the "older revision" event still lands.
    const withLater = applyAgentControlStreamEvent(
      hydrated,
      proposalEvent(12, makeProposal("p3", { status: "approved" })),
    );
    const withEarlier = applyAgentControlStreamEvent(
      withLater,
      proposalEvent(11, makeProposal("p2")),
    );
    expect(Object.keys(withEarlier.proposalsById).toSorted()).toEqual(["p1", "p2", "p3"]);
  });

  it("never lets a terminal document be overwritten by a stale non-terminal one", () => {
    const hydrated = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 0 }),
    );
    const expired = applyAgentControlStreamEvent(
      hydrated,
      proposalEvent(1, makeProposal("p1", { status: "expired" })),
    );
    // A commit-before-publish inversion can deliver the earlier "approved"
    // document with a HIGHER revision after the terminal one; terminal wins.
    const afterStale = applyAgentControlStreamEvent(
      expired,
      proposalEvent(2, makeProposal("p1", { status: "approved" })),
    );
    expect(afterStale.proposalsById.p1?.status).toBe("expired");
  });

  it("resets the dedupe baseline on a resubscribe snapshot", () => {
    const hydrated = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 100, active: [makeProposal("p1")] }),
    );
    // A server restart resets revisions; the fresh snapshot must win even
    // though its revision is lower.
    const resubscribed = applyAgentControlStreamEvent(
      hydrated,
      snapshotEvent({ revision: 2, active: [makeProposal("p2")] }),
    );
    expect(resubscribed.revision).toBe(2);
    expect(Object.keys(resubscribed.proposalsById)).toEqual(["p2"]);

    const next = applyAgentControlStreamEvent(resubscribed, proposalEvent(3, makeProposal("p3")));
    expect(Object.keys(next.proposalsById).toSorted()).toEqual(["p2", "p3"]);
  });

  it("keeps terminal proposals as bounded history", () => {
    let state = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 0 }),
    );
    for (let index = 0; index < AGENT_CONTROL_CLIENT_HISTORY_LIMIT + 5; index += 1) {
      state = applyAgentControlStreamEvent(
        state,
        proposalEvent(
          index + 1,
          makeProposal(`terminal-${String(index).padStart(3, "0")}`, {
            status: "rejected",
            updatedAt: `2026-08-17T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          }),
        ),
      );
    }
    const recent = selectRecentAgentControlProposals(state);
    expect(recent).toHaveLength(AGENT_CONTROL_CLIENT_HISTORY_LIMIT);
    // Newest history first; the oldest entries were pruned.
    expect(recent[0]!.updatedAt >= recent[recent.length - 1]!.updatedAt).toBe(true);
  });
});

describe("selectors", () => {
  const terminalStatuses: AgentControlProposalStatus[] = [
    "rejected",
    "expired",
    "completed",
    "failed",
    "cancelled",
  ];

  it("partitions active and recent proposals", () => {
    let state = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 0 }),
    );
    state = applyAgentControlStreamEvent(
      state,
      proposalEvent(1, makeProposal("pending", { createdAt: "2026-08-17T00:00:01.000Z" })),
    );
    state = applyAgentControlStreamEvent(
      state,
      proposalEvent(
        2,
        makeProposal("approved", { status: "approved", createdAt: "2026-08-17T00:00:02.000Z" }),
      ),
    );
    state = applyAgentControlStreamEvent(
      state,
      proposalEvent(
        3,
        makeProposal("executing", { status: "executing", createdAt: "2026-08-17T00:00:03.000Z" }),
      ),
    );
    for (const [index, status] of terminalStatuses.entries()) {
      state = applyAgentControlStreamEvent(
        state,
        proposalEvent(4 + index, makeProposal(`terminal-${status}`, { status })),
      );
    }

    expect(selectActiveAgentControlProposals(state).map((entry) => entry.proposalId)).toEqual([
      "pending",
      "approved",
      "executing",
    ]);
    expect(selectRecentAgentControlProposals(state)).toHaveLength(terminalStatuses.length);
  });

  it("scopes thread-local proposals to the caller thread principal", () => {
    let state = applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 0 }),
    );
    state = applyAgentControlStreamEvent(state, proposalEvent(1, makeProposal("mine")));
    state = applyAgentControlStreamEvent(
      state,
      proposalEvent(
        2,
        makeProposal("other-thread", {
          principal: {
            kind: "provider-session",
            threadId: ThreadId.make("thread-other"),
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        }),
      ),
    );
    state = applyAgentControlStreamEvent(
      state,
      proposalEvent(
        3,
        makeProposal("external", {
          principal: {
            kind: "external-integration",
            integrationId: "integration-1" as never,
          },
        }),
      ),
    );

    expect(
      selectAgentControlProposalsForThread(state, callerThreadId).map((entry) => entry.proposalId),
    ).toEqual(["mine"]);
  });
});

describe("thread activity", () => {
  const target = ThreadId.make("thread-target");
  const queue = (...proposals: AgentControlProposal[]) =>
    applyAgentControlStreamEvent(
      EMPTY_AGENT_CONTROL_QUEUE_STATE,
      snapshotEvent({ revision: 0, active: proposals }),
    );

  it("keeps external requests reachable without mixing in provider or automation approvals", () => {
    const external = makeProposal("external", {
      principal: { kind: "external-integration", integrationId: "integration" as never },
    });
    const running = {
      ...external,
      proposalId: AgentControlProposalId.make("running"),
      status: "executing" as const,
    };
    const state = queue(
      makeProposal("thread-request"),
      external,
      running,
      { ...external, proposalId: AgentControlProposalId.make("completed"), status: "completed" },
      makeProposal("automation", {
        principal: {
          kind: "automation-owner",
          projectId: ProjectId.make("project"),
          runtimeMode: "approval-required",
          envMode: "local",
        },
      }),
    );
    const selection = selectAgentControlExternalActivity(state);
    expect(selection.pending.map((proposal) => proposal.proposalId)).toEqual(["external"]);
    expect(selection.activity.map((proposal) => proposal.proposalId)).toEqual(["running"]);
    expect(selection.managerThreadId).toBeNull();
    expect(selectAgentControlThreadActivity(state, null).pending).toEqual([]);
    const reconnected = applyAgentControlStreamEvent(
      state,
      snapshotEvent({ revision: 0, active: Object.values(state.proposalsById) }),
    );
    expect(selectAgentControlExternalActivity(reconnected)).toEqual(selection);
  });

  it("only shows the originating thread's approvals and latest activity", () => {
    const state = queue(
      makeProposal("pending"),
      makeProposal("completed", { status: "completed" }),
      makeProposal("latest", { status: "executing", updatedAt: "2026-09-30T00:00:00.000Z" }),
      makeProposal("other", {
        principal: {
          kind: "provider-session",
          threadId: target,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
      makeProposal("external", {
        principal: { kind: "external-integration", integrationId: "external" as never },
      }),
    );
    const selection = selectAgentControlThreadActivity(state, callerThreadId);
    expect(selection.pending.map((proposal) => proposal.proposalId)).toEqual(["pending"]);
    expect(selection.activity.map((proposal) => proposal.proposalId)).toEqual([
      "latest",
      "completed",
    ]);
    expect(selection.managerThreadId).toBeNull();
    expect(selectAgentControlThreadActivity(state, ThreadId.make("unrelated"))).toEqual({
      pending: [],
      activity: [],
      managerThreadId: null,
      delegatedFromThreadId: null,
    });
    expect(selectAgentControlThreadActivity(state, null)).toEqual({
      pending: [],
      activity: [],
      managerThreadId: null,
      delegatedFromThreadId: null,
    });
  });

  it("shows only a manager notice in the target and preserves it across a snapshot", () => {
    const state = queue(makeProposal("accepted", { status: "completed" }));
    const expected = {
      pending: [],
      activity: [],
      managerThreadId: callerThreadId,
      delegatedFromThreadId: null,
    };
    expect(selectAgentControlThreadActivity(state, target)).toEqual(expected);
    const reconnected = applyAgentControlStreamEvent(
      state,
      snapshotEvent({ revision: 0, recent: Object.values(state.proposalsById) }),
    );
    expect(selectAgentControlThreadActivity(reconnected, target)).toEqual(expected);
  });

  it("does not infer management from unaccepted, failed, or self-directed work", () => {
    for (const status of [
      "pending-user-approval",
      "rejected",
      "expired",
      "failed",
      "cancelled",
    ] as const) {
      expect(
        selectAgentControlThreadActivity(queue(makeProposal("request", { status })), target)
          .managerThreadId,
      ).toBeNull();
    }
    const self = makeProposal("self", {
      status: "completed",
      plan: { kind: "sendMessage", threadId: callerThreadId, text: "self", delivery: "queue" },
    });
    expect(
      selectAgentControlThreadActivity(queue(self), callerThreadId).managerThreadId,
    ).toBeNull();
  });

  it("uses creation receipts for delegated children and selects the latest manager", () => {
    const created = makeProposal("created", {
      status: "completed",
      plan: {
        kind: "createThreads",
        entries: [
          {
            projectId: ProjectId.make("project"),
            title: "Child task",
            prompt: "Work on the task",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
            runtimeMode: "approval-required",
            envMode: "local",
          },
        ],
      },
      result: {
        outcome: "completed",
        createdThreadIds: [target],
        completedAt: "2026-08-17T00:00:00.000Z",
      },
    });
    expect(selectAgentControlThreadActivity(queue(created), target)).toMatchObject({
      delegatedFromThreadId: callerThreadId,
      managerThreadId: null,
    });
    const withReturn = {
      ...created,
      result: null,
      completionReturns: [
        {
          revision: 1,
          childThreadId: target,
          initialMessageId: MessageId.make("initial"),
          parentThreadId: callerThreadId,
          parentTurnId: TurnId.make("turn"),
          childTurnId: null,
          status: "waiting" as const,
          detail: "Waiting",
          updatedAt: created.updatedAt,
        },
      ],
    };
    expect(selectAgentControlThreadActivity(queue(withReturn), target)).toMatchObject({
      delegatedFromThreadId: callerThreadId,
      managerThreadId: null,
    });
    const newManager = ThreadId.make("new-manager");
    const newer = makeProposal("newer", {
      status: "executing",
      decidedAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
      principal: {
        kind: "provider-session",
        threadId: newManager,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    });
    expect(selectAgentControlThreadActivity(queue(created, newer), target)).toMatchObject({
      delegatedFromThreadId: callerThreadId,
      managerThreadId: newManager,
    });
  });

  it("does not replace a newer manager when an older action receives a delayed child return", () => {
    const older = makeProposal("older", {
      status: "completed",
      decidedAt: "2026-08-17T00:01:00.000Z",
      updatedAt: "2026-08-17T00:02:00.000Z",
      plan: {
        kind: "createThreads",
        entries: [
          {
            projectId: ProjectId.make("project"),
            title: "Child task",
            prompt: "Work on the task",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
            runtimeMode: "approval-required",
            envMode: "local",
            returnToOrigin: true,
          },
        ],
      },
      result: {
        outcome: "completed",
        createdThreadIds: [target],
        completedAt: "2026-08-17T00:02:00.000Z",
      },
      completionReturns: [
        {
          revision: 1,
          childThreadId: target,
          initialMessageId: MessageId.make("initial"),
          parentThreadId: callerThreadId,
          parentTurnId: TurnId.make("origin"),
          childTurnId: null,
          status: "waiting",
          detail: "Waiting",
          updatedAt: "2026-08-17T00:02:00.000Z",
        },
      ],
    });
    const newManager = ThreadId.make("new-manager");
    const newer = makeProposal("newer", {
      status: "completed",
      createdAt: "2026-08-17T00:03:00.000Z",
      decidedAt: "2026-08-17T00:04:00.000Z",
      updatedAt: "2026-08-17T00:05:00.000Z",
      result: { outcome: "completed", completedAt: "2026-08-17T00:05:00.000Z" },
      principal: {
        kind: "provider-session",
        threadId: newManager,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    });
    const state = applyAgentControlStreamEvent(
      queue(older, newer),
      proposalEvent(2, {
        ...older,
        updatedAt: "2026-09-30T00:00:00.000Z",
        completionReturns: [
          {
            ...older.completionReturns![0]!,
            revision: 2,
            status: "delivered",
            updatedAt: "2026-09-30T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(selectAgentControlThreadActivity(state, callerThreadId).activity[0]?.proposalId).toBe(
      "older",
    );
    expect(selectAgentControlThreadActivity(state, target)).toMatchObject({
      managerThreadId: newManager,
      delegatedFromThreadId: callerThreadId,
    });
    const reconnected = applyAgentControlStreamEvent(
      state,
      snapshotEvent({ revision: 0, recent: Object.values(state.proposalsById) }),
    );
    expect(selectAgentControlThreadActivity(reconnected, target).managerThreadId).toBe(newManager);
  });

  it("prefers server lineage for the creator and hides a manager that is the same thread", () => {
    const lineageParent = ThreadId.make("lineage-parent");
    const lineage = {
      parentThreadId: lineageParent,
      rootThreadId: lineageParent,
      relationship: "delegated",
    };
    const created = makeProposal("created", {
      status: "completed",
      plan: {
        kind: "createThreads",
        entries: [
          {
            projectId: ProjectId.make("project"),
            title: "Child task",
            prompt: "Work on the task",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
            runtimeMode: "approval-required",
            envMode: "local",
          },
        ],
      },
      result: {
        outcome: "completed",
        createdThreadIds: [target],
        completedAt: "2026-08-17T00:00:00.000Z",
      },
    });
    // Server lineage wins over a different inferred creator.
    expect(selectAgentControlThreadActivity(queue(created), target, lineage)).toMatchObject({
      delegatedFromThreadId: lineageParent,
      managerThreadId: callerThreadId,
    });
    // Only lineage (no proposal history): the creator is still known.
    expect(
      selectAgentControlThreadActivity(EMPTY_AGENT_CONTROL_QUEUE_STATE, target, lineage),
    ).toEqual({
      pending: [],
      activity: [],
      managerThreadId: null,
      delegatedFromThreadId: lineageParent,
    });
    // A manager equal to the lineage parent is suppressed.
    const parentManaged = makeProposal("parent-managed", {
      status: "completed",
      principal: {
        kind: "provider-session",
        threadId: lineageParent,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    });
    expect(selectAgentControlThreadActivity(queue(parentManaged), target, lineage)).toMatchObject({
      delegatedFromThreadId: lineageParent,
      managerThreadId: null,
    });
    // An unknown relationship falls back to receipt inference.
    expect(
      selectAgentControlThreadActivity(queue(created), target, {
        ...lineage,
        relationship: "future-kind",
      }),
    ).toMatchObject({ delegatedFromThreadId: callerThreadId, managerThreadId: null });
  });

  it("does not treat affected threads of a project operation as managed children", () => {
    const projectOperation = makeProposal("project-operation", {
      status: "completed",
      plan: {
        kind: "removeProject",
        projectId: ProjectId.make("project"),
        expected: {
          title: "Project",
          workspaceRoot: "/workspace/project",
          repositoryIdentityKey: null,
          updatedAt: "2026-08-17T00:00:00.000Z",
        },
        expectedThreadIds: [target],
        force: false,
      },
    });
    expect(
      selectAgentControlThreadActivity(queue(projectOperation), target).managerThreadId,
    ).toBeNull();
  });
});

it("updates child completion after dispatch completes, keeps waiting returns visible, and rejects stale return revisions", () => {
  const waiting = {
    revision: 1,
    childThreadId: ThreadId.make("child"),
    initialMessageId: MessageId.make("initial"),
    parentThreadId: callerThreadId,
    parentTurnId: TurnId.make("origin"),
    childTurnId: null,
    status: "waiting" as const,
    detail: "Waiting",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const proposal = makeProposal("delegated", { status: "completed", completionReturns: [waiting] });
  let state = applyAgentControlStreamEvent(
    EMPTY_AGENT_CONTROL_QUEUE_STATE,
    snapshotEvent({ revision: 8, active: [proposal] }),
  );
  expect(selectActiveAgentControlProposals(state)).toHaveLength(1);
  expect(selectRecentAgentControlProposals(state)).toHaveLength(0);
  state = applyAgentControlStreamEvent(
    state,
    proposalEvent(9, {
      ...proposal,
      completionReturns: [
        {
          ...waiting,
          revision: 3,
          status: "uncertain",
          detail: "Check parent before manual retry",
        },
      ],
    }),
  );
  expect(state.proposalsById[proposal.proposalId]?.status).toBe("completed");
  expect(state.proposalsById[proposal.proposalId]?.completionReturns?.[0]?.status).toBe(
    "uncertain",
  );
  expect(selectActiveAgentControlProposals(state)).toHaveLength(0);
  expect(selectAgentControlProposalsForThread(state, callerThreadId)).toHaveLength(1);
  expect(applyAgentControlStreamEvent(state, proposalEvent(10, proposal))).toBe(state);
  expect(
    applyAgentControlStreamEvent(
      state,
      proposalEvent(11, {
        ...proposal,
        completionReturns: [
          { ...waiting, revision: 99, parentTurnId: TurnId.make("wrong-origin") },
        ],
      }),
    ),
  ).toBe(state);
  const restarted = applyAgentControlStreamEvent(
    state,
    snapshotEvent({ revision: 0, recent: Object.values(state.proposalsById) }),
  );
  expect(restarted.proposalsById[proposal.proposalId]?.completionReturns?.[0]?.revision).toBe(3);
});
