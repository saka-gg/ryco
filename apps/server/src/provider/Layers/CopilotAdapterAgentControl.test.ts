import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import type { SessionConfig } from "@github/copilot-sdk";

import { ServerConfig } from "../../config.ts";
import type { AgentControlProviderBridge } from "../../agentControl/ProviderInjection.ts";
import { installProcessDeviceToolGateway } from "../../providerTools/deviceToolGateway.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const threadId = ThreadId.make("thread-copilot-agent-control");
const instanceId = ProviderInstanceId.make("copilot");
const runtimeSessionId = RuntimeSessionId.make("runtime-copilot-agent-control");
const rawCredential = `rycoac_${"a".repeat(43)}`;
const testLayer = ServerConfig.layerTest("/tmp", "/tmp").pipe(
  Layer.provideMerge(NodeServices.layer),
);

function makeBridge() {
  const revokeLease = vi.fn(
    (_input: Parameters<AgentControlProviderBridge["revokeLease"]>[0]) => Effect.void,
  );
  const bridge: AgentControlProviderBridge = {
    issueLease: () =>
      Effect.succeed(
        Option.some({
          sessionId: "copilot-agent-control-session",
          endpointUrl: "http://127.0.0.1:45000/mcp",
          credential: Redacted.make(rawCredential),
        }),
      ),
    issueStdioBootstrap: () => Effect.succeed(Option.none()),
    revokeLease,
    bindTurnAuthority: ({ sessionId, turnId }) =>
      Effect.succeed({ sessionId, threadId, turnId, boundAt: new Date().toISOString() }),
    retireTurnAuthority: () => Effect.void,
  };
  return { bridge, revokeLease };
}

function makeClient(configs: Array<SessionConfig>, failInjected = false) {
  const session = {
    sessionId: "copilot-session-1",
    on: () => () => {},
    disconnect: async () => {},
    abort: async () => {},
    send: async () => {},
    setModel: async () => {},
  };
  let failed = false;
  const createSession = async (config: SessionConfig) => {
    configs.push(config);
    if (failInjected && config.mcpServers && !failed) {
      failed = true;
      throw new Error("mock MCP setup failure");
    }
    return session;
  };
  return {
    createSession,
    resumeSession: async (_sessionId: string, config: SessionConfig) => createSession(config),
    stop: async () => {},
  };
}

const startInput = {
  provider: ProviderDriverKind.make("copilot"),
  providerInstanceId: instanceId,
  runtimeSessionId,
  threadId,
  runtimeMode: "approval-required" as const,
};

it.effect("installs Copilot's native per-session HTTP MCP config and revokes it on stop", () => {
  const configs: Array<SessionConfig> = [];
  const state = makeBridge();
  return Effect.gen(function* () {
    installProcessDeviceToolGateway({
      createBinding: () => ({
        url: "http://127.0.0.1:46000/device",
        headers: { Authorization: "Bearer device-token" },
        dispose: () => undefined,
      }),
      close: async () => undefined,
    });
    const adapter = yield* makeCopilotAdapter(
      { binaryPath: "copilot" },
      {
        instanceId,
        agentControl: state.bridge,
        clientFactory: () => makeClient(configs) as never,
      },
    );
    const session = yield* adapter.startSession(startInput);
    assert.notInclude(JSON.stringify(session), rawCredential);
    assert.deepStrictEqual(configs[0]?.mcpServers?.ryco, {
      type: "http",
      url: "http://127.0.0.1:45000/mcp",
      headers: { Authorization: `Bearer ${rawCredential}` },
    });
    assert.deepStrictEqual(configs[0]?.mcpServers?.ryco_device, {
      type: "http",
      url: "http://127.0.0.1:46000/device",
      headers: { Authorization: "Bearer device-token" },
    });
    assert.strictEqual(configs[0]?.mcpOAuthTokenStorage, "in-memory");
    assert.include(
      String(
        configs[0]?.systemMessage && "content" in configs[0].systemMessage
          ? configs[0].systemMessage.content
          : "",
      ),
      "Ryco Agent Control tools",
    );
    yield* adapter.stopSession(threadId);
    assert.isAtLeast(state.revokeLease.mock.calls.length, 1);
    assert.strictEqual(
      state.revokeLease.mock.calls[0]?.[0].sessionId,
      "copilot-agent-control-session",
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => installProcessDeviceToolGateway(null))),
    Effect.provide(testLayer),
  );
});

it.effect("retries Copilot startup without Agent Control after injected MCP setup fails", () => {
  const configs: Array<SessionConfig> = [];
  const state = makeBridge();
  return Effect.gen(function* () {
    const adapter = yield* makeCopilotAdapter(
      { binaryPath: "copilot" },
      {
        instanceId,
        agentControl: state.bridge,
        clientFactory: () => makeClient(configs, true) as never,
      },
    );
    yield* adapter.startSession(startInput);
    assert.strictEqual(configs.length, 2);
    assert.isDefined(configs[0]?.mcpServers?.ryco);
    assert.isUndefined(configs[1]?.mcpServers);
    assert.include(
      String(
        configs[1]?.systemMessage && "content" in configs[1].systemMessage
          ? configs[1].systemMessage.content
          : "",
      ),
      "unavailable for this provider session",
    );
    assert.isAtLeast(state.revokeLease.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer));
});

it.effect("a rejected second start leaves the live session's Agent Control alone", () => {
  const configs: Array<SessionConfig> = [];
  const state = makeBridge();
  return Effect.gen(function* () {
    const adapter = yield* makeCopilotAdapter(
      { binaryPath: "copilot" },
      {
        instanceId,
        agentControl: state.bridge,
        clientFactory: () => makeClient(configs) as never,
      },
    );
    yield* adapter.startSession(startInput);
    const error = yield* Effect.flip(
      adapter.startSession({
        ...startInput,
        runtimeSessionId: RuntimeSessionId.make("runtime-copilot-other"),
      }),
    );
    assert.strictEqual(error._tag, "ProviderAdapterValidationError");
    assert.include(String((error as { issue?: string }).issue), "stop it before starting");
    assert.strictEqual(state.revokeLease.mock.calls.length, 0);
    yield* adapter.stopSession(threadId);
    assert.isAtLeast(state.revokeLease.mock.calls.length, 1);
  }).pipe(Effect.provide(testLayer));
});
