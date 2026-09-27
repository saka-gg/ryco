import { describe, expect, it } from "vite-plus/test";
import {
  AgentControlProposalId,
  MessageId,
  TurnId,
  AgentControlRequestId,
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
    expect(recent[0]?.updatedAt >= recent[recent.length - 1]!.updatedAt).toBe(true);
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
