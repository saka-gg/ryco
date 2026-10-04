import {
  AGENT_CONTROL_CAPABILITIES,
  type AgentControlExternalIntegrationCreateInput,
  ProjectId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  DEFAULT_HUB_CONNECTOR_CONFIG,
  ServerConfig,
  type ServerConfigShape,
} from "../../config.ts";
import { AgentControlExternalRepositoryLive } from "../../persistence/Layers/AgentControlExternal.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { HUB_CONNECTED_EXTERNAL_TOPOLOGY } from "../externalTopology.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalTopologyService } from "../Services/AgentControlExternalTopology.ts";
import { AgentControlExternalIntegrationServiceLive } from "./AgentControlExternalIntegration.ts";
import { AgentControlExternalTopologyLive } from "./AgentControlExternalTopology.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";

const configWith = (hubConnector: ServerConfigShape["hubConnector"]) =>
  Layer.succeed(ServerConfig, {
    host: "127.0.0.1",
    tailscaleServeEnabled: false,
    hubConnector,
    stateDir: "/tmp/ryco-external-topology-tests",
  } as ServerConfigShape);

const layerWith = (hubConnector: ServerConfigShape["hubConnector"]) =>
  AgentControlExternalIntegrationServiceLive.pipe(
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlExternalRepositoryLive),
    Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(AgentControlExternalTopologyLive),
    Layer.provide(configWith(hubConnector)),
  );

const enabledHub = {
  ...DEFAULT_HUB_CONNECTOR_CONFIG,
  enabled: true,
  origin: "https://hub.example.com",
};
const standbyHub = { ...enabledHub, standby: true } as const;

const createInput: AgentControlExternalIntegrationCreateInput = {
  displayName: "Local Codex",
  clientKind: "codex",
  projectScope: { kind: "selected", projectIds: [ProjectId.make("project-1")] },
  capabilities: [AGENT_CONTROL_CAPABILITIES.externalListProjects],
  rateLimitPerMinute: 10,
  activeTaskLimit: 1,
  expiresAt: null,
};

it.layer(layerWith(standbyHub))("AgentControlExternalTopology with a standby connector", (it) => {
  it.effect("keeps external integrations until the Hub connector takes the process", () =>
    Effect.gen(function* () {
      const topology = yield* AgentControlExternalTopologyService;
      const integrations = yield* AgentControlExternalIntegrationService;
      // A desktop that never used the Hub launches its connector in standby;
      // its external integrations must keep working.
      assert.deepStrictEqual((yield* integrations.list()).topology, {
        available: true,
        reason: null,
      });
      yield* integrations.create(createInput);

      let closes = 0;
      yield* topology.onYieldToHub(
        Effect.sync(() => {
          closes += 1;
        }),
      );
      yield* topology.yieldToHub;
      assert.strictEqual(closes, 1);
      assert.deepStrictEqual(topology.current(), HUB_CONNECTED_EXTERNAL_TOPOLOGY);
      assert.deepStrictEqual(
        (yield* integrations.list()).topology,
        HUB_CONNECTED_EXTERNAL_TOPOLOGY,
      );
      const refused = yield* Effect.flip(integrations.create(createInput));
      assert.strictEqual("reason" in refused ? refused.reason : null, "topology-unavailable");

      // Idempotent, and never widens again.
      yield* topology.yieldToHub;
      assert.strictEqual(closes, 2);
      assert.deepStrictEqual(topology.current(), HUB_CONNECTED_EXTERNAL_TOPOLOGY);
    }),
  );
});

it.layer(layerWith(enabledHub))("AgentControlExternalTopology with an enabled connector", (it) => {
  it.effect("refuses external integrations from the start", () =>
    Effect.gen(function* () {
      const topology = yield* AgentControlExternalTopologyService;
      assert.deepStrictEqual(topology.current(), HUB_CONNECTED_EXTERNAL_TOPOLOGY);
    }),
  );
});
