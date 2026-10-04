import {
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlInjectionMode,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";

import type { AgentControlProviderBridge } from "./ProviderInjection.ts";
import { AGENT_CONTROL_MCP_INITIALIZE_INSTRUCTIONS } from "./Mcp/listener.ts";
import {
  AGENT_CONTROL_PROVIDER_SUPPORT,
  agentControlHostContext,
  installAgentControlAcp,
  installAgentControlNativeHttp,
  redactAgentControlSecrets,
} from "./ProviderInjection.ts";

const bearer = `rycoac_${"a".repeat(43)}`;
const bootstrap = `rycoacb_${"b".repeat(43)}`;
const threadId = ThreadId.make("thread-provider-injection");
const providerInstanceId = ProviderInstanceId.make("cursor");
const runtimeSessionId = RuntimeSessionId.make("runtime-provider-injection");

const makeBridge = () => {
  const issuedModes: Array<AgentControlInjectionMode> = [];
  const revoked: Array<string> = [];
  const bound: Array<string> = [];
  const retired: Array<string | undefined> = [];
  const bridge: AgentControlProviderBridge = {
    issueLease: (input) =>
      Effect.sync(() => {
        issuedModes.push(input.injectionMode);
        return Option.some({
          sessionId: `lease-${input.runtimeSessionId}`,
          endpointUrl: "http://127.0.0.1:45000/mcp",
          credential: Redacted.make(bearer),
        });
      }),
    issueStdioBootstrap: (input) =>
      Effect.sync(() => {
        issuedModes.push(input.injectionMode);
        return Option.some({
          sessionId: `lease-${input.runtimeSessionId}`,
          endpointUrl: "http://127.0.0.1:45000/mcp",
          bootstrapToken: Redacted.make(bootstrap),
          expiresAt: Date.now() + 30_000,
        });
      }),
    revokeLease: ({ sessionId }) =>
      Effect.sync(() => {
        revoked.push(sessionId);
      }),
    bindTurnAuthority: ({ sessionId, turnId }) =>
      Effect.sync(() => {
        bound.push(`${sessionId}:${turnId}`);
        return { sessionId, threadId, turnId, boundAt: new Date().toISOString() };
      }),
    retireTurnAuthority: ({ turnId }) =>
      Effect.sync(() => {
        retired.push(turnId);
      }),
  };
  return { bridge, issuedModes, revoked, bound, retired };
};

it("records truthful runtime-scope decisions for every rollout provider", () => {
  assert.deepInclude(AGENT_CONTROL_PROVIDER_SUPPORT.claudeAgent, {
    supported: true,
    runtimeScoped: true,
    http: "native",
    configurationScope: "runtime-session",
  });
  assert.deepInclude(AGENT_CONTROL_PROVIDER_SUPPORT.cursor, {
    supported: true,
    http: "advertised",
    stdio: "proxy",
  });
  assert.deepInclude(AGENT_CONTROL_PROVIDER_SUPPORT.copilot, {
    supported: true,
    runtimeScoped: true,
    http: "native",
  });
  assert.deepInclude(AGENT_CONTROL_PROVIDER_SUPPORT.opencode, {
    supported: false,
    runtimeScoped: false,
    configurationScope: "directory",
  });
  assert.match(AGENT_CONTROL_PROVIDER_SUPPORT.opencode.reason ?? "", /another Ryco thread/);
});

it.effect("builds native HTTP configuration and exact-lease lifecycle operations", () =>
  Effect.gen(function* () {
    const state = makeBridge();
    const installed = yield* installAgentControlNativeHttp(state.bridge, {
      threadId,
      providerInstanceId,
      runtimeSessionId,
      injectionMode: "claude-http",
    });
    assert.isTrue(Option.isSome(installed));
    if (Option.isNone(installed)) return;
    assert.deepStrictEqual(installed.value.mcpServer, {
      type: "http",
      url: "http://127.0.0.1:45000/mcp",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    yield* installed.value.bindTurn(TurnId.make("turn-1"));
    yield* installed.value.retireTurn(TurnId.make("turn-1"));
    yield* installed.value.revoke("session-stopped");
    assert.deepStrictEqual(state.issuedModes, ["claude-http"]);
    assert.deepStrictEqual(state.bound, [`lease-${runtimeSessionId}:turn-1`]);
    assert.deepStrictEqual(state.retired, ["turn-1"]);
    assert.deepStrictEqual(state.revoked, [`lease-${runtimeSessionId}`]);
  }),
);

it.effect(
  "uses ACP HTTP only when advertised and otherwise emits a bootstrap-only stdio proxy",
  () =>
    Effect.gen(function* () {
      const httpState = makeBridge();
      const http = yield* installAgentControlAcp(httpState.bridge, {
        threadId,
        providerInstanceId,
        runtimeSessionId,
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } },
        },
        proxyCommand: "/usr/bin/node",
        proxyEntryPoint: "/opt/ryco/bin.mjs",
      });
      assert.isTrue(Option.isSome(http));
      if (Option.isSome(http)) {
        assert.isTrue("type" in http.value.mcpServer);
        if ("type" in http.value.mcpServer) {
          assert.strictEqual(http.value.mcpServer.type, "http");
        }
      }
      assert.deepStrictEqual(httpState.issuedModes, ["acp-http"]);

      const stdioState = makeBridge();
      const stdio = yield* installAgentControlAcp(stdioState.bridge, {
        threadId,
        providerInstanceId,
        runtimeSessionId,
        initializeResult: { protocolVersion: 1, agentCapabilities: {} },
        proxyCommand: "/usr/bin/node",
        proxyEntryPoint: "/opt/ryco/bin.mjs",
      });
      assert.isTrue(Option.isSome(stdio));
      if (Option.isNone(stdio)) return;
      assert.isUndefined("type" in stdio.value.mcpServer ? stdio.value.mcpServer.type : undefined);
      const serialized = JSON.stringify(stdio.value.mcpServer);
      assert.notInclude(serialized, bearer);
      assert.include(serialized, bootstrap);
      assert.deepStrictEqual(stdioState.issuedModes, ["acp-stdio-proxy"]);
    }),
);

it("redacts bearer and bootstrap material from nested native log payloads", () => {
  const redacted = JSON.stringify(
    redactAgentControlSecrets({ headers: { authorization: `Bearer ${bearer}` }, bootstrap }),
  );
  assert.notInclude(redacted, bearer);
  assert.notInclude(redacted, bootstrap);
  assert.include(redacted, "[REDACTED]");
});

it("redacts provider error messages before they can reach logs or persisted events", () => {
  assert.deepStrictEqual(
    redactAgentControlSecrets(new Error(`failed with Bearer rycoac_${"c".repeat(43)}`)),
    {
      name: "Error",
      message: "failed with Bearer [REDACTED]",
    },
  );
});

it("tells agents to delegate, confirm, end their turn and let Ryco wake them", () => {
  const context = agentControlHostContext(true);
  assert.include(context, "end your turn");
  assert.include(context, "returnToOrigin: true");
  assert.include(context, 'ryco_wait_for_control_request (waitFor: "terminal")');
  assert.include(context, "ryco_task_status");
  assert.include(context, "ryco_task_cancel");
  assert.include(context, "untrusted reference data");
  assert.notInclude(context, "ryco_wait_threads to follow work");
  assert.include(AGENT_CONTROL_MCP_INITIALIZE_INSTRUCTIONS, "end your turn");
  assert.include(AGENT_CONTROL_MCP_INITIALIZE_INSTRUCTIONS, "ryco_task_status");
  assert.notInclude(
    AGENT_CONTROL_MCP_INITIALIZE_INSTRUCTIONS,
    "ryco_wait_threads for task completion",
  );
});
