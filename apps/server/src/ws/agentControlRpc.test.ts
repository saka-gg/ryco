import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlActionPlan,
  AgentControlProposalId,
  AgentControlRequestId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlProposal,
  type AgentControlProposalQueue,
  type AgentControlProposalReceipt,
  type AgentControlProposalStreamEvent,
  type AgentControlRpcError,
  type AuthRpcError,
} from "@ryco/contracts";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema, Stream } from "effect";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";

import {
  AgentControlDisabledError,
  AgentControlInvalidTransitionError,
  AgentControlNodeDirectoryError,
  AgentControlProposalExpiredError,
  AgentControlProposalNotFoundError,
  AgentControlSettingsChangeUnsupportedError,
} from "../agentControl/Errors.ts";
import {
  AgentControlNodeDirectory,
  type AgentControlNodeDirectoryShape,
  type PublishAgentControlNodeDirectoryInput,
} from "../agentControl/Services/AgentControlNodeDirectory.ts";
import {
  toAgentControlProposalReceipt,
  type AcceptAgentControlProposalRequest,
  type AgentControlProposalServiceShape,
} from "../agentControl/Services/AgentControlProposalService.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import {
  isProposalInPlanView,
  makeAgentControlHandlers,
  proposalQueueInPlanView,
  proposalStreamEventInPlanView,
  toAgentControlRpcError,
} from "./agentControlRpc.ts";
import type { WsRpcContext } from "./context.ts";
import { relayRpcPrincipal, type RpcPrincipal } from "./RpcPrincipal.ts";

const proposalId = AgentControlProposalId.make("proposal-1");

const proposal: AgentControlProposal = {
  proposalId,
  requestId: AgentControlRequestId.make("request-1"),
  principal: {
    kind: "provider-session",
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  planVersion: 1,
  plan: {
    kind: "sendMessage",
    threadId: ThreadId.make("thread-2"),
    text: "Continue with the migration.",
    delivery: "queue",
  },
  planDigest: "a".repeat(64),
  riskTags: [],
  promptSummary: "Send a message to thread-2",
  status: "pending-user-approval",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  expiresAt: "2026-08-17T01:00:00.000Z",
  decidedAt: null,
  result: null,
};

const emptyQueue: AgentControlProposalQueue = {
  revision: 7,
  active: [proposal],
  recent: [],
};

const unimplemented = (name: string) => () => Effect.die(`${name} not implemented in this test`);

const makeService = (
  overrides: Partial<AgentControlProposalServiceShape> = {},
): AgentControlProposalServiceShape => ({
  submit: unimplemented("submit"),
  getQueue: () => Effect.succeed(emptyQueue),
  getProposal: () => Effect.succeed(Option.some(proposal)),
  accept: () => Effect.succeed(toAgentControlProposalReceipt(proposal)),
  reject: () => Effect.succeed(toAgentControlProposalReceipt(proposal)),
  expireOverdue: () => Effect.succeed([]),
  subscribeQueue: () =>
    Stream.make({ version: 1 as const, type: "snapshot" as const, queue: emptyQueue }),
  ...overrides,
});

// Relay principals model hosted sessions, so the same harness exercises
// hosted role enforcement directly.
const makeContext = (
  principal: RpcPrincipal,
  service: AgentControlProposalServiceShape | null = makeService(),
  nodeDirectory: AgentControlNodeDirectoryShape | null = null,
) => {
  const withAccess = <A, E, R>(
    access: WsRpcAccess,
    method: string,
    effect: Effect.Effect<A, E, R>,
  ) => authorizeRpcPrincipal(principal, access, method).pipe(Effect.flatMap(() => effect));
  const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    withAccess("owner", method, effect);

  return {
    ownerEffect,
    ownerStreamEffect: ownerEffect,
    agentControlProposals: service === null ? Option.none() : Option.some(service),
    agentControlNodeDirectory: nodeDirectory === null ? Option.none() : Option.some(nodeDirectory),
    currentSessionId: principal.scopeId,
  } as unknown as WsRpcContext;
};

const directOwnerPrincipal: RpcPrincipal = {
  transport: "direct",
  role: "owner",
  scopeId: "session-owner",
  canManageLocalAccess: true,
};

type AgentControlHandlers = ReturnType<typeof makeAgentControlHandlers>;

type AgentControlHandlerError = AgentControlRpcError | AuthRpcError;

function getTestHandler<Input, Output = never>(
  handlers: AgentControlHandlers,
  method: keyof AgentControlHandlers,
): (input: Input) => Effect.Effect<Output, AgentControlHandlerError, never> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`Missing RPC handler for ${String(method)}`);
  }
  return handler as unknown as (
    input: Input,
  ) => Effect.Effect<Output, AgentControlHandlerError, never>;
}

/** Stream RPC handlers return the stream itself, not an effect of one. */
function getTestStreamHandler<Input, Output = never>(
  handlers: AgentControlHandlers,
  method: keyof AgentControlHandlers,
): (input: Input) => Stream.Stream<Output, AgentControlHandlerError, never> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`Missing RPC handler for ${String(method)}`);
  }
  return handler as unknown as (
    input: Input,
  ) => Stream.Stream<Output, AgentControlHandlerError, never>;
}

it.effect("refuses non-owner principals — including hosted roles — on every method", () =>
  Effect.gen(function* () {
    for (const role of ["viewer", "operator"] as const) {
      const handlers = makeAgentControlHandlers(
        makeContext(relayRpcPrincipal(role, `relay-${role}`)),
      );
      const listError = yield* Effect.flip(
        getTestHandler(handlers, AGENT_CONTROL_WS_METHODS.listProposals)({}),
      );
      expect((listError as { _tag: string })._tag).toBe("AuthRpcError");
      const getError = yield* Effect.flip(
        getTestHandler(handlers, AGENT_CONTROL_WS_METHODS.getProposal)({ proposalId }),
      );
      expect((getError as { _tag: string })._tag).toBe("AuthRpcError");
      const acceptError = yield* Effect.flip(
        getTestHandler(handlers, AGENT_CONTROL_WS_METHODS.acceptProposal)({ proposalId }),
      );
      expect((acceptError as { _tag: string })._tag).toBe("AuthRpcError");
      const rejectError = yield* Effect.flip(
        getTestHandler(handlers, AGENT_CONTROL_WS_METHODS.rejectProposal)({ proposalId }),
      );
      expect((rejectError as { _tag: string })._tag).toBe("AuthRpcError");
      const subscribeError = yield* Effect.flip(
        Stream.runCollect(
          getTestStreamHandler(handlers, AGENT_CONTROL_WS_METHODS.subscribeProposals)({}),
        ),
      );
      expect((subscribeError as { _tag: string })._tag).toBe("AuthRpcError");
    }
  }),
);

it.effect("lets owner sessions list, read, and decide", () =>
  Effect.gen(function* () {
    const acceptedWith: Array<{ proposalId: string; decidedAt: string }> = [];
    const service = makeService({
      accept: (input) =>
        Effect.sync(() => {
          acceptedWith.push({ proposalId: input.proposalId, decidedAt: input.decidedAt });
          return toAgentControlProposalReceipt({ ...proposal, status: "approved" });
        }),
    });
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal, service));

    const queue = yield* getTestHandler<object, AgentControlProposalQueue>(
      handlers,
      AGENT_CONTROL_WS_METHODS.listProposals,
    )({ activeLimit: 5 });
    expect(queue.revision).toBe(7);
    expect(queue.active).toHaveLength(1);

    const read = yield* getTestHandler<object, { proposal: AgentControlProposal | null }>(
      handlers,
      AGENT_CONTROL_WS_METHODS.getProposal,
    )({ proposalId });
    expect(read.proposal?.proposalId).toBe(proposalId);

    const receipt = yield* getTestHandler<object, AgentControlProposalReceipt>(
      handlers,
      AGENT_CONTROL_WS_METHODS.acceptProposal,
    )({ proposalId });
    expect(receipt.status).toBe("approved");
    expect(acceptedWith).toHaveLength(1);
    expect(acceptedWith[0]?.proposalId).toBe(proposalId);
    // The server stamps the decision time; clients never supply it.
    expect(Number.isNaN(Date.parse(acceptedWith[0]?.decidedAt ?? ""))).toBe(false);
  }),
);

it.effect("passes the approving client's executor to the decision", () =>
  Effect.gen(function* () {
    const accepted: Array<AcceptAgentControlProposalRequest> = [];
    const service = makeService({
      accept: (input) =>
        Effect.sync(() => {
          accepted.push(input);
          return toAgentControlProposalReceipt({ ...proposal, status: "approved" });
        }),
    });
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal, service));
    const accept = getTestHandler<object, AgentControlProposalReceipt>(
      handlers,
      AGENT_CONTROL_WS_METHODS.acceptProposal,
    );
    const executeOnClient = { executorId: "00000000-0000-4000-8000-000000000003" };
    yield* accept({ proposalId, executeOnClient });
    yield* accept({ proposalId });
    expect(accepted.map((input) => input.executeOnClient)).toEqual([executeOnClient, undefined]);
  }),
);

it.effect("hands an owner's node directory to the directory, keyed by its session", () =>
  Effect.gen(function* () {
    const published: Array<PublishAgentControlNodeDirectoryInput> = [];
    const directory: AgentControlNodeDirectoryShape = {
      publish: (input) =>
        Effect.sync(() => {
          published.push(input);
          return { accepted: input.nodes.length };
        }),
      list: () => Effect.succeed({ nodes: [] }),
    };
    const handlers = makeAgentControlHandlers(
      makeContext(directOwnerPrincipal, makeService(), directory),
    );
    const result = yield* getTestHandler<object, { accepted: number }>(
      handlers,
      AGENT_CONTROL_WS_METHODS.publishNodeDirectory,
    )({ nodes: [] });
    expect(result).toEqual({ accepted: 0 });
    expect(published).toEqual([{ publisherKey: "session-owner", nodes: [] }]);

    // A directory that is unavailable, or none at all, refuses publishing as unsupported.
    const unavailable = () =>
      Effect.fail(
        new AgentControlNodeDirectoryError({ reason: "unavailable", detail: "unavailable" }),
      );
    const unavailableDirectory = AgentControlNodeDirectory.of({
      publish: unavailable,
      list: unavailable,
    });
    for (const nodeDirectory of [unavailableDirectory, null]) {
      const refused = yield* Effect.flip(
        getTestHandler(
          makeAgentControlHandlers(makeContext(directOwnerPrincipal, makeService(), nodeDirectory)),
          AGENT_CONTROL_WS_METHODS.publishNodeDirectory,
        )({ nodes: [] }),
      );
      expect(refused).toMatchObject({ _tag: "AgentControlRpcError", code: "unsupported" });
    }
  }),
);

it.effect("streams the queue snapshot to owner sessions", () =>
  Effect.gen(function* () {
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal));
    const stream = getTestStreamHandler<object, { type: string }>(
      handlers,
      AGENT_CONTROL_WS_METHODS.subscribeProposals,
    )({});
    const events = Array.from(yield* Stream.runCollect(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("snapshot");

    // A hosted owner (relay principal) is equally authorized.
    const hostedHandlers = makeAgentControlHandlers(
      makeContext(relayRpcPrincipal("owner", "relay-owner")),
    );
    const hostedQueue = yield* getTestHandler<object, AgentControlProposalQueue>(
      hostedHandlers,
      AGENT_CONTROL_WS_METHODS.listProposals,
    )({});
    expect(hostedQueue.revision).toBe(7);
  }),
);

const decodePlan = Schema.decodeUnknownSync(AgentControlActionPlan);

/** Proposals of the two kinds clients built before them cannot decode. */
const importProposal: AgentControlProposal = {
  ...proposal,
  proposalId: AgentControlProposalId.make("proposal-import"),
  plan: decodePlan({
    kind: "importProject",
    projectId: "2a7c1d3e-7d2c-4e4a-9b1f-4c8da6e50f9b",
    title: "ryco",
    destinationPath: "/Users/me/Code/ryco",
    remoteUrl: "git@github.com:example/ryco.git",
    branch: null,
    setup: null,
    followUpThread: null,
  }),
};
const copyProposal: AgentControlProposal = {
  ...proposal,
  proposalId: AgentControlProposalId.make("proposal-copy"),
  status: "completed",
  plan: decodePlan({
    kind: "copyProjectToNode",
    source: { kind: "repository", remoteUrl: "https://github.com/example/ryco", title: "ryco" },
    target: { environmentId: "env-mac-mini", label: "Mac mini" },
    destination: { kind: "default" },
    bringCommits: false,
    bringChanges: false,
    copySettings: true,
    setup: null,
    followUpThread: null,
  }),
};
const mixedQueue: AgentControlProposalQueue = {
  revision: 9,
  active: [importProposal, proposal],
  recent: [copyProposal],
};

const proposalIdsOf = (event: AgentControlProposalStreamEvent | undefined) =>
  event?.type === "snapshot"
    ? {
        active: event.queue.active.map((entry) => entry.proposalId),
        recent: event.queue.recent.map((entry) => entry.proposalId),
      }
    : event?.proposal.proposalId;

it.effect("a legacy subscriber never receives the new kinds", () =>
  Effect.gen(function* () {
    const events: ReadonlyArray<AgentControlProposalStreamEvent> = [
      { version: 1, type: "snapshot", queue: mixedQueue },
      { version: 1, type: "proposal", revision: 10, proposal: importProposal },
      { version: 1, type: "proposal", revision: 11, proposal },
      { version: 1, type: "proposal", revision: 12, proposal: copyProposal },
    ];
    const service = makeService({ subscribeQueue: () => Stream.fromIterable(events) });
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal, service));
    const subscribe = getTestStreamHandler<object, AgentControlProposalStreamEvent>(
      handlers,
      AGENT_CONTROL_WS_METHODS.subscribeProposals,
    );

    // A client built before these kinds sends no `planView`.
    const legacy = Array.from(yield* Stream.runCollect(subscribe({})));
    expect(legacy.map(proposalIdsOf)).toEqual([{ active: [proposalId], recent: [] }, proposalId]);
    expect(legacy[0]).toMatchObject({ type: "snapshot", queue: { revision: 9 } });

    const tolerant = Array.from(yield* Stream.runCollect(subscribe({ planView: "tolerant" })));
    expect(tolerant.map(proposalIdsOf)).toEqual([
      { active: [importProposal.proposalId, proposalId], recent: [copyProposal.proposalId] },
      importProposal.proposalId,
      proposalId,
      copyProposal.proposalId,
    ]);
  }),
);

it.effect("leaves the new kinds out of legacy queue and proposal reads", () =>
  Effect.gen(function* () {
    const service = makeService({
      getQueue: () => Effect.succeed(mixedQueue),
      getProposal: (id) =>
        Effect.succeed(
          Option.fromNullishOr(
            [proposal, importProposal, copyProposal].find((entry) => entry.proposalId === id),
          ),
        ),
    });
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal, service));
    const list = getTestHandler<object, AgentControlProposalQueue>(
      handlers,
      AGENT_CONTROL_WS_METHODS.listProposals,
    );
    const get = getTestHandler<object, { proposal: AgentControlProposal | null }>(
      handlers,
      AGENT_CONTROL_WS_METHODS.getProposal,
    );

    const legacyQueue = yield* list({ recentLimit: 50 });
    expect(legacyQueue.revision).toBe(9);
    expect(legacyQueue.active.map((entry) => entry.proposalId)).toEqual([proposalId]);
    expect(legacyQueue.recent).toEqual([]);
    expect(yield* list({ planView: "tolerant" })).toBe(mixedQueue);

    expect((yield* get({ proposalId: importProposal.proposalId })).proposal).toBeNull();
    expect((yield* get({ proposalId: copyProposal.proposalId })).proposal).toBeNull();
    expect((yield* get({ proposalId })).proposal?.proposalId).toBe(proposalId);
    expect(
      (yield* get({ proposalId: copyProposal.proposalId, planView: "tolerant" })).proposal,
    ).toBe(copyProposal);
  }),
);

it("passes a queue of legacy kinds through unchanged", () => {
  const event: AgentControlProposalStreamEvent = {
    version: 1,
    type: "snapshot",
    queue: emptyQueue,
  };
  expect(proposalQueueInPlanView(emptyQueue, undefined)).toBe(emptyQueue);
  expect(proposalStreamEventInPlanView(event, undefined)).toBe(event);
  expect(isProposalInPlanView(copyProposal, undefined)).toBe(false);
  expect(isProposalInPlanView(copyProposal, "tolerant")).toBe(true);
});

it.effect("reports an unavailable service as a bounded storage error", () =>
  Effect.gen(function* () {
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal, null));
    const error = yield* Effect.flip(
      getTestHandler(handlers, AGENT_CONTROL_WS_METHODS.listProposals)({}),
    );
    expect(error).toMatchObject({ _tag: "AgentControlRpcError", code: "storage" });
  }),
);

it.effect("maps lifecycle failures onto bounded RPC error codes", () =>
  Effect.gen(function* () {
    const disabled = toAgentControlRpcError(
      new AgentControlDisabledError({ operation: "AgentControlProposalService.getQueue" }),
    );
    expect(disabled.code).toBe("disabled");

    const notFound = toAgentControlRpcError(new AgentControlProposalNotFoundError({ proposalId }));
    expect(notFound.code).toBe("not-found");

    const expired = toAgentControlRpcError(
      new AgentControlProposalExpiredError({
        proposalId,
        expiresAt: "2026-08-17T01:00:00.000Z",
      }),
    );
    expect(expired.code).toBe("expired");
    expect(expired.status).toBe("expired");

    const conflict = toAgentControlRpcError(
      new AgentControlInvalidTransitionError({
        entity: "proposal",
        from: "rejected",
        to: "approved",
        actor: "user",
        detail: "no legal transition from rejected to approved",
      }),
    );
    expect(conflict.code).toBe("conflict");
    expect(conflict.status).toBe("rejected");

    const unsupported = toAgentControlRpcError(
      new AgentControlSettingsChangeUnsupportedError({
        detail: "Fresh owner reauthentication is unavailable.",
      }),
    );
    expect(unsupported.code).toBe("unsupported");
    expect(unsupported.message).toContain("reauthentication");

    const storage = toAgentControlRpcError(
      new PersistenceSqlError({ operation: "op", detail: "database is locked" }),
    );
    expect(storage.code).toBe("storage");
    // Storage details must not cross the RPC boundary.
    expect(storage.message).not.toContain("database is locked");

    // A decision that failed through a handler surfaces the mapped error.
    const service = makeService({
      reject: () => Effect.fail(new AgentControlProposalNotFoundError({ proposalId })),
    });
    const handlers = makeAgentControlHandlers(makeContext(directOwnerPrincipal, service));
    const error = yield* Effect.flip(
      getTestHandler(handlers, AGENT_CONTROL_WS_METHODS.rejectProposal)({ proposalId }),
    );
    expect(error).toMatchObject({ _tag: "AgentControlRpcError", code: "not-found" });
  }),
);

it.effect("enforces hosted owner authorization for every Agent Control method", () =>
  Effect.sync(() => {
    for (const method of Object.values(AGENT_CONTROL_WS_METHODS)) {
      expect(hostedRoleAllows("owner", method)).toBe(true);
      expect(hostedRoleAllows("operator", method)).toBe(false);
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows(null, method)).toBe(false);
      // A stale hosted role snapshot cannot authorize decisions.
      expect(hostedRoleAllows("owner", method, false)).toBe(false);
    }
  }),
);
