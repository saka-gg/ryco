import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_MCP_TOOLS,
  AgentControlProposalId,
  AgentControlRequestId,
  ProviderInstanceId,
  RuntimeSessionId,
  ServerSettings,
  ThreadId,
  type AgentControlProposal,
  type AgentControlProposalStreamProposalEvent,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { AGENT_CONTROL_MCP_MAX_BODY_BYTES, AGENT_CONTROL_MCP_PATH } from "../Mcp/transportGuard.ts";
import { makeAgentControlMcpListener } from "../Mcp/listener.ts";
import { makeAgentControlMcpTools, type AgentControlMcpToolDeps } from "../Mcp/tools.ts";
import {
  AgentControlPolicy,
  type AgentControlPolicyShape,
} from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalService } from "../Services/AgentControlProposalService.ts";
import {
  AgentControlSessionRegistry,
  type AgentControlIssuedLease,
  type AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import { AgentControlMcpServerLive } from "./AgentControlMcpServer.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlSessionRegistryLive } from "./AgentControlSessionRegistry.ts";

const callerThreadId = ThreadId.make("thread-caller");
const codexInstance = ProviderInstanceId.make("codex");
const runtime1 = RuntimeSessionId.make("runtime-1");

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const die = (name: string) => (): never => {
  throw new Error(`${name} not stubbed`);
};

const projectionsStub: ProjectionSnapshotQueryShape = {
  getCommandReadModel: die("getCommandReadModel"),
  getSnapshot: die("getSnapshot"),
  getShellSnapshot: () =>
    Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: T0 }),
  getSnapshotSequence: die("getSnapshotSequence"),
  getCounts: die("getCounts"),
  getActiveProjectByWorkspaceRoot: die("getActiveProjectByWorkspaceRoot"),
  getProjectShellById: () => Effect.succeed(Option.none()),
  getFirstActiveThreadIdByProjectId: die("getFirstActiveThreadIdByProjectId"),
  getThreadCheckpointContext: die("getThreadCheckpointContext"),
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadDetailById: die("getThreadDetailById"),
  searchThreadMessages: die("searchThreadMessages"),
};

const T0 = "2026-08-18T00:00:00.000Z";

const pendingProposal: AgentControlProposal = {
  proposalId: AgentControlProposalId.make("proposal-wait"),
  requestId: AgentControlRequestId.make("request-wait"),
  principal: {
    kind: "provider-session",
    threadId: callerThreadId,
    providerInstanceId: codexInstance,
  },
  planVersion: 1,
  plan: {
    kind: "sendMessage",
    threadId: ThreadId.make("thread-other"),
    text: "Queued message.",
    delivery: "queue",
  },
  planDigest: "a".repeat(64),
  riskTags: [],
  promptSummary: null,
  status: "pending-user-approval",
  createdAt: T0,
  updatedAt: T0,
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedAt: null,
  result: null,
};

const makeToolDeps = (
  policy: AgentControlPolicyShape,
  events: Effect.Effect<
    PubSub.Subscription<AgentControlProposalStreamProposalEvent>,
    never,
    Scope.Scope
  >,
): AgentControlMcpToolDeps => ({
  policy,
  proposals: {
    getProposal: (proposalId) =>
      Effect.succeed(
        proposalId === pendingProposal.proposalId ? Option.some(pendingProposal) : Option.none(),
      ),
  },
  proposalEvents: { subscribe: events },
  projections: projectionsStub,
  getProviders: Effect.succeed([]),
});

/**
 * Boot a real registry (enabled feature gate) plus the real loopback
 * listener, publish the endpoint, and hand the test a leased credential.
 */
const withListener = <A, E>(
  run: (input: {
    readonly origin: string;
    readonly url: string;
    readonly registry: AgentControlSessionRegistryShape;
    readonly lease: AgentControlIssuedLease;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registryContext = yield* Layer.build(
        AgentControlSessionRegistryLive.pipe(
          Layer.provideMerge(AgentControlPolicyLive),
          Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
        ),
      );
      const registry = Context.get(registryContext, AgentControlSessionRegistry);
      const policy = Context.get(registryContext, AgentControlPolicy);
      const waitPubsub = yield* PubSub.unbounded<AgentControlProposalStreamProposalEvent>();
      const tools = makeAgentControlMcpTools(makeToolDeps(policy, PubSub.subscribe(waitPubsub)));

      const handle = yield* makeAgentControlMcpListener({ registry, tools });
      yield* registry.publishEndpoint({ url: handle.url });

      const lease = yield* registry.issueLease({
        threadId: callerThreadId,
        providerInstanceId: codexInstance,
        runtimeSessionId: runtime1,
        capabilities: [
          AGENT_CONTROL_CAPABILITIES.read,
          AGENT_CONTROL_CAPABILITIES.createProject,
          AGENT_CONTROL_CAPABILITIES.updateProject,
          AGENT_CONTROL_CAPABILITIES.removeProject,
          AGENT_CONTROL_CAPABILITIES.readSettings,
          AGENT_CONTROL_CAPABILITIES.changeSettings,
        ],
        injectionMode: "codex-http",
      });
      assert.isTrue(Option.isSome(lease));

      return yield* run({
        origin: `http://127.0.0.1:${handle.port}`,
        url: handle.url,
        registry,
        lease: (lease as Option.Some<AgentControlIssuedLease>).value,
      });
    }),
  );

interface McpHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

const post = (
  url: string,
  input: {
    readonly body?: string;
    readonly bearer?: string;
    readonly headers?: Record<string, string>;
    readonly method?: string;
  },
): Effect.Effect<McpHttpResponse> =>
  Effect.promise(async () => {
    const response = await fetch(url, {
      method: input.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(input.bearer === undefined ? {} : { authorization: `Bearer ${input.bearer}` }),
        ...input.headers,
      },
      ...(input.method === "GET" ? {} : { body: input.body ?? "{}" }),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  });

const rpc = (
  url: string,
  bearer: string,
  method: string,
  params?: unknown,
  id: number | null = 1,
) =>
  post(url, {
    bearer,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });

const parseBody = (response: McpHttpResponse): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

it.live("speaks the MCP protocol: initialize, ping, tools/list, tools/call", () =>
  withListener(({ url, lease }) =>
    Effect.gen(function* () {
      const bearer = Redacted.value(lease.credential);

      const initialize = yield* rpc(url, bearer, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codex", version: "1" },
      });
      assert.strictEqual(initialize.status, 200);
      assert.isNull(initialize.headers.get("access-control-allow-origin"));
      const initializeResult = parseBody(initialize).result as Record<string, unknown>;
      assert.strictEqual(initializeResult.protocolVersion, "2025-03-26");
      assert.deepStrictEqual(initializeResult.capabilities, { tools: { listChanged: false } });
      assert.include(initializeResult.instructions as string, "user approval");

      const initialized = yield* post(url, {
        bearer,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.strictEqual(initialized.status, 202);

      const ping = yield* rpc(url, bearer, "ping");
      assert.deepStrictEqual(parseBody(ping).result, {});

      const toolsList = yield* rpc(url, bearer, "tools/list");
      const tools = (parseBody(toolsList).result as { tools: ReadonlyArray<{ name: string }> })
        .tools;
      assert.deepStrictEqual(
        tools.map((tool) => tool.name).toSorted(),
        [
          AGENT_CONTROL_MCP_TOOLS.context,
          AGENT_CONTROL_MCP_TOOLS.capabilities,
          AGENT_CONTROL_MCP_TOOLS.listProjects,
          AGENT_CONTROL_MCP_TOOLS.listThreads,
          AGENT_CONTROL_MCP_TOOLS.readThread,
          AGENT_CONTROL_MCP_TOOLS.readControlRequest,
          AGENT_CONTROL_MCP_TOOLS.waitForControlRequest,
          AGENT_CONTROL_MCP_TOOLS.settingsSummary,
          AGENT_CONTROL_MCP_TOOLS.proposeProjectCreate,
          AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate,
          AGENT_CONTROL_MCP_TOOLS.proposeProjectRemove,
          AGENT_CONTROL_MCP_TOOLS.proposeSettingsChange,
        ].toSorted(),
      );

      const contextCall = yield* rpc(url, bearer, "tools/call", {
        name: AGENT_CONTROL_MCP_TOOLS.context,
        arguments: {},
      });
      const callResult = parseBody(contextCall).result as {
        readonly isError?: boolean;
        readonly structuredContent: { readonly threadId: string };
      };
      assert.isUndefined(callResult.isError);
      assert.strictEqual(callResult.structuredContent.threadId, "thread-caller");
    }),
  ),
);

it.live("exchanges an ACP stdio bootstrap exactly once on the private listener", () =>
  withListener(({ url, registry }) =>
    Effect.gen(function* () {
      const issued = yield* registry.issueStdioBootstrap({
        threadId: callerThreadId,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        runtimeSessionId: runtime1,
        capabilities: [AGENT_CONTROL_CAPABILITIES.read],
        injectionMode: "acp-stdio-proxy",
      });
      assert.isTrue(Option.isSome(issued));
      if (Option.isNone(issued)) return;
      const bootstrapUrl = url.replace(/\/mcp$/, "/_agent-control/bootstrap");
      const token = Redacted.value(issued.value.bootstrapToken);
      const first = yield* post(bootstrapUrl, { body: JSON.stringify({ token }) });
      assert.strictEqual(first.status, 200);
      const payload = JSON.parse(first.body) as { authorization: string; endpointUrl: string };
      assert.match(payload.authorization, /^Bearer rycoac_/);
      assert.strictEqual(payload.endpointUrl, url);
      const second = yield* post(bootstrapUrl, { body: JSON.stringify({ token }) });
      assert.strictEqual(second.status, 401);
    }),
  ),
);

it.live("rejects missing, malformed, unknown, and revoked credentials with 401", () =>
  withListener(({ url, registry, lease }) =>
    Effect.gen(function* () {
      const noAuth = yield* post(url, { body: "{}" });
      assert.strictEqual(noAuth.status, 401);
      assert.strictEqual(noAuth.headers.get("www-authenticate"), "Bearer");
      assert.isNull(noAuth.headers.get("access-control-allow-origin"));

      const malformed = yield* post(url, { bearer: "hub-session-token", body: "{}" });
      assert.strictEqual(malformed.status, 401);

      const external = yield* post(url, { bearer: `rycoext_${"A".repeat(43)}`, body: "{}" });
      assert.strictEqual(external.status, 401);

      const unknown = yield* post(url, { bearer: `rycoac_${"B".repeat(43)}`, body: "{}" });
      assert.strictEqual(unknown.status, 401);

      const bearer = Redacted.value(lease.credential);
      const before = yield* rpc(url, bearer, "ping");
      assert.strictEqual(before.status, 200);
      yield* registry.revokeLeases({ threadId: callerThreadId, reason: "runtime-teardown" });
      const revoked = yield* rpc(url, bearer, "ping");
      assert.strictEqual(revoked.status, 401);
    }),
  ),
);

it.live("refuses browser, hub, and desktop-control transport surfaces", () =>
  withListener(({ origin, url, lease }) =>
    Effect.gen(function* () {
      const bearer = Redacted.value(lease.credential);

      const withOrigin = yield* post(url, {
        bearer,
        headers: { origin: "https://evil.example" },
      });
      assert.strictEqual(withOrigin.status, 403);
      assert.isNull(withOrigin.headers.get("access-control-allow-origin"));

      const withCookie = yield* post(url, { bearer, headers: { cookie: "ryco_session=abc" } });
      assert.strictEqual(withCookie.status, 403);

      const withDesktopControl = yield* post(url, {
        bearer,
        headers: { "x-ryco-desktop-control": "token" },
      });
      assert.strictEqual(withDesktopControl.status, 403);

      const get = yield* post(url, { bearer, method: "GET" });
      assert.strictEqual(get.status, 405);

      const wrongPath = yield* post(`${origin}/rpc`, { bearer });
      assert.strictEqual(wrongPath.status, 404);
      assert.strictEqual(url, `${origin}${AGENT_CONTROL_MCP_PATH}`);
    }),
  ),
);

it.live("bounds request bodies, refuses batches, and answers protocol errors", () =>
  withListener(({ url, lease }) =>
    Effect.gen(function* () {
      const bearer = Redacted.value(lease.credential);

      const batch = yield* post(url, {
        bearer,
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
      });
      assert.strictEqual(batch.status, 400);
      assert.strictEqual((parseBody(batch).error as { code: number }).code, -32600);

      const invalidJson = yield* post(url, { bearer, body: "{nope" });
      assert.strictEqual(invalidJson.status, 400);
      assert.strictEqual((parseBody(invalidJson).error as { code: number }).code, -32700);

      const oversized = yield* post(url, {
        bearer,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
          params: { padding: "y".repeat(AGENT_CONTROL_MCP_MAX_BODY_BYTES + 1) },
        }),
      });
      assert.strictEqual(oversized.status, 413);

      const unknownMethod = yield* rpc(url, bearer, "resources/list");
      assert.strictEqual((parseBody(unknownMethod).error as { code: number }).code, -32601);

      const unknownTool = yield* rpc(url, bearer, "tools/call", {
        name: "ryco_create_threads",
        arguments: {},
      });
      const denied = parseBody(unknownTool).result as {
        readonly isError: boolean;
        readonly content: ReadonlyArray<{ readonly text: string }>;
      };
      assert.isTrue(denied.isError);
      assert.include(denied.content[0]?.text ?? "", "Exact active-turn");
    }),
  ),
);

it.live("lease revocation aborts an in-flight wait request", () =>
  withListener(({ url, registry, lease }) =>
    Effect.gen(function* () {
      const bearer = Redacted.value(lease.credential);
      const fiber = yield* Effect.forkChild(
        rpc(url, bearer, "tools/call", {
          name: AGENT_CONTROL_MCP_TOOLS.waitForControlRequest,
          arguments: { proposalId: "proposal-wait", timeoutMs: 30_000 },
        }),
      );
      yield* Effect.sleep("150 millis");
      yield* registry.revokeLeases({ threadId: callerThreadId, reason: "runtime-teardown" });
      const response = yield* Fiber.join(fiber);
      assert.strictEqual(response.status, 200);
      assert.strictEqual((parseBody(response).error as { code: number }).code, -32603);
    }),
  ),
);

// ── Lifecycle layer ───────────────────────────────────────────────────

const proposalServiceStub = Layer.succeed(AgentControlProposalService, {
  submit: die("submit"),
  getQueue: die("getQueue"),
  getProposal: () => Effect.succeed(Option.none()),
  accept: die("accept"),
  reject: die("reject"),
  expireOverdue: die("expireOverdue"),
  subscribeQueue: die("subscribeQueue"),
});

const proposalEventsStub = Layer.effect(
  AgentControlProposalEvents,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<AgentControlProposalStreamProposalEvent>();
    return {
      publish: die("publish"),
      currentRevision: Effect.succeed(0),
      subscribe: PubSub.subscribe(pubsub),
      get changes() {
        return Stream.fromPubSub(pubsub);
      },
    };
  }),
);

const providerRegistryStub = Layer.succeed(ProviderRegistry, {
  getProviders: Effect.succeed([]),
  revalidateStale: Effect.succeed([]),
  refresh: die("refresh"),
  refreshInstance: die("refreshInstance"),
  getProviderMaintenanceCapabilitiesForInstance: die(
    "getProviderMaintenanceCapabilitiesForInstance",
  ),
  setProviderMaintenanceActionState: die("setProviderMaintenanceActionState"),
  streamChanges: Stream.empty,
});

const makeMcpServerLayer = (settingsLayer: Layer.Layer<ServerSettingsService>) =>
  AgentControlMcpServerLive.pipe(
    Layer.provideMerge(AgentControlSessionRegistryLive),
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(proposalServiceStub),
    Layer.provideMerge(proposalEventsStub),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionsStub)),
    Layer.provideMerge(providerRegistryStub),
    Layer.provideMerge(settingsLayer),
  );

it.live("feature-disabled mode starts no listener and issues no leases", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(makeMcpServerLayer(ServerSettingsService.layerTest({})));
      const registry = Context.get(context, AgentControlSessionRegistry);
      assert.isTrue(Option.isNone(yield* registry.currentEndpoint));
      const lease = yield* registry.issueLease({
        threadId: callerThreadId,
        providerInstanceId: codexInstance,
        runtimeSessionId: runtime1,
        capabilities: [AGENT_CONTROL_CAPABILITIES.read],
        injectionMode: "codex-http",
      });
      assert.isTrue(Option.isNone(lease));
    }),
  ),
);

it.live("enabled mode starts a loopback listener and publishes its endpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        makeMcpServerLayer(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
      );
      const registry = Context.get(context, AgentControlSessionRegistry);
      const endpoint = yield* registry.currentEndpoint;
      assert.isTrue(Option.isSome(endpoint));
      const url = (endpoint as Option.Some<{ url: string }>).value.url;
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      // The listener is really up: an unauthenticated probe gets 401.
      const probe = yield* post(url, { body: "{}" });
      assert.strictEqual(probe.status, 401);
    }),
  ),
);

const makeFlippableSettings = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerSettings>();
  const ref = yield* Ref.make(decodeSettings({ agentControl: { enabled: true } }));
  const shape: ServerSettingsShape = {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(ref),
    updateSettings: die("updateSettings"),
    get streamChanges() {
      return Stream.fromPubSub(pubsub);
    },
  };
  return {
    layer: Layer.succeed(ServerSettingsService, shape),
    setEnabled: (enabled: boolean) =>
      Effect.gen(function* () {
        const next = decodeSettings({ agentControl: { enabled } });
        yield* Ref.set(ref, next);
        yield* PubSub.publish(pubsub, next);
      }),
  };
});

const awaitEndpointState = (
  registry: AgentControlSessionRegistryShape,
  expected: "present" | "absent",
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const endpoint = yield* registry.currentEndpoint;
      if ((expected === "present") === Option.isSome(endpoint)) return endpoint;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(`endpoint never became ${expected}`);
  });

it.live("disabling the setting at runtime stops the listener and revokes leases", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* makeFlippableSettings;
      const context = yield* Layer.build(makeMcpServerLayer(settings.layer));
      const registry = Context.get(context, AgentControlSessionRegistry);

      const endpoint = yield* awaitEndpointState(registry, "present");
      const url = (endpoint as Option.Some<{ url: string }>).value.url;
      const lease = yield* registry.issueLease({
        threadId: callerThreadId,
        providerInstanceId: codexInstance,
        runtimeSessionId: runtime1,
        capabilities: [AGENT_CONTROL_CAPABILITIES.read],
        injectionMode: "codex-http",
      });
      assert.isTrue(Option.isSome(lease));
      const bearer = Redacted.value(
        (lease as Option.Some<AgentControlIssuedLease>).value.credential,
      );

      // The watcher fiber subscribes asynchronously after layer build; a
      // single publish could land before its subscription exists. Re-emit
      // the falling edge until the listener converges.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          yield* settings.setEnabled(false);
          const endpoint = yield* registry.currentEndpoint;
          if (Option.isNone(endpoint)) return;
          yield* Effect.sleep("20 millis");
        }
        return yield* Effect.die("endpoint never became absent");
      });
      assert.strictEqual(yield* registry.activeSessionCount, 0);
      const rejected = yield* Effect.flip(registry.authenticate(`Bearer ${bearer}`));
      assert.strictEqual(rejected.reason, "unknown");

      // The socket is closed; a request now fails at the network layer.
      const attempt = yield* Effect.promise(() =>
        fetch(url, { method: "POST" }).then(
          () => "reachable" as const,
          () => "unreachable" as const,
        ),
      );
      assert.strictEqual(attempt, "unreachable");
    }),
  ),
);

it.live("server shutdown closes the listener and invalidates credentials", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const context = yield* Layer.build(
      makeMcpServerLayer(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
    ).pipe(Scope.provide(scope));
    const registry = Context.get(context, AgentControlSessionRegistry);
    const endpoint = yield* registry.currentEndpoint;
    assert.isTrue(Option.isSome(endpoint));
    const url = (endpoint as Option.Some<{ url: string }>).value.url;
    const lease = yield* registry.issueLease({
      threadId: callerThreadId,
      providerInstanceId: codexInstance,
      runtimeSessionId: runtime1,
      capabilities: [AGENT_CONTROL_CAPABILITIES.read],
      injectionMode: "codex-http",
    });
    assert.isTrue(Option.isSome(lease));
    const bearer = Redacted.value((lease as Option.Some<AgentControlIssuedLease>).value.credential);

    yield* Scope.close(scope, Exit.void);

    const rejected = yield* Effect.flip(registry.authenticate(`Bearer ${bearer}`));
    assert.strictEqual(rejected.reason, "unknown");
    const attempt = yield* Effect.promise(() =>
      fetch(url, { method: "POST" }).then(
        () => "reachable" as const,
        () => "unreachable" as const,
      ),
    );
    assert.strictEqual(attempt, "unreachable");
  }),
);
