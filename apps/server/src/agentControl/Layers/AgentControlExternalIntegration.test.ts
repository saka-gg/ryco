import {
  AGENT_CONTROL_CAPABILITIES,
  type AgentControlExternalIntegrationCreateInput,
  ProjectId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { AgentControlExternalRepositoryLive } from "../../persistence/Layers/AgentControlExternal.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AgentControlExternalRepository } from "../../persistence/Services/AgentControlExternal.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalIntegrationServiceLive } from "./AgentControlExternalIntegration.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlExternalTopologyLive } from "./AgentControlExternalTopology.ts";

const config = Layer.succeed(ServerConfig, {
  host: "127.0.0.1",
  tailscaleServeEnabled: false,
  hubConnector: { enabled: false },
  stateDir: "/tmp/ryco-external-integration-tests",
} as ServerConfigShape);

const layer = it.layer(
  AgentControlExternalIntegrationServiceLive.pipe(
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlExternalRepositoryLive),
    Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(AgentControlExternalTopologyLive),
    Layer.provide(config),
  ),
);

const createInput = (
  overrides: Partial<AgentControlExternalIntegrationCreateInput> = {},
): AgentControlExternalIntegrationCreateInput => ({
  displayName: "Local Codex",
  clientKind: "codex",
  projectScope: { kind: "selected", projectIds: [ProjectId.make("project-1")] },
  capabilities: [
    AGENT_CONTROL_CAPABILITIES.externalListProjects,
    AGENT_CONTROL_CAPABILITIES.externalCreateTask,
    AGENT_CONTROL_CAPABILITIES.externalReadTask,
  ],
  rateLimitPerMinute: 10,
  activeTaskLimit: 1,
  expiresAt: null,
  ...overrides,
});

const reasonOf = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    throw new Error("Expected an external integration error");
  }
  return String(error.reason);
};

layer("AgentControlExternalIntegrationService", (it) => {
  it.effect("issues and rotates a paired credential only through the server-only path", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const created = yield* service.createPaired(createInput({ displayName: "One-click Codex" }));
      const first = Redacted.value(created.credential);
      assert.match(first, /^rycoext_/);
      assert.strictEqual(created.detail.integration.pairingState, "paired");
      assert.notInclude(JSON.stringify(created.detail), first);
      assert.strictEqual(
        (yield* service.authenticate(`Bearer ${first}`)).integration.displayName,
        "One-click Codex",
      );

      const rotated = yield* service.rotateCredential(created.detail.integration.integrationId);
      const second = Redacted.value(rotated.credential);
      assert.notStrictEqual(second, first);
      assert.strictEqual(
        reasonOf(yield* Effect.flip(service.authenticate(`Bearer ${first}`))),
        "credential-refused",
      );
      assert.strictEqual(
        (yield* service.authenticate(`Bearer ${second}`)).integration.integrationId,
        created.detail.integration.integrationId,
      );
      assert.notInclude(JSON.stringify(yield* service.list()), second);
    }),
  );

  it.effect("creates, updates, pairs once, resumes pairing, and revokes immediately", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const created = yield* service.create(createInput());
      assert.strictEqual(created.detail.integration.pairingState, "pending");
      assert.match(created.pairingCode, /^[A-Z2-9]{10}$/);
      assert.notInclude(JSON.stringify(created.detail.setup), created.pairingCode);

      const mistyped = yield* Effect.flip(
        service.exchangePairing({
          integrationId: created.detail.integration.integrationId,
          pairingCode: "AAAAAAAAAA",
        }),
      );
      assert.strictEqual(reasonOf(mistyped), "pairing-refused");

      const exchanged = yield* service.exchangePairing({
        integrationId: created.detail.integration.integrationId,
        pairingCode: created.pairingCode,
      });
      const credential = Redacted.value(exchanged.credential);
      assert.match(credential, /^rycoext_/);
      const repeated = yield* Effect.flip(
        service.exchangePairing({
          integrationId: created.detail.integration.integrationId,
          pairingCode: created.pairingCode,
        }),
      );
      assert.strictEqual(repeated._tag, "AgentControlExternalIntegrationError");
      assert.strictEqual(reasonOf(repeated), "pairing-refused");

      const authenticated = yield* service.authenticate(`Bearer ${credential}`);
      assert.strictEqual(authenticated.integration.displayName, "Local Codex");
      const updated = yield* service.update({
        integrationId: created.detail.integration.integrationId,
        displayName: "Renamed Codex",
        activeTaskLimit: 2,
      });
      assert.strictEqual(updated.integration.displayName, "Renamed Codex");
      assert.strictEqual(updated.integration.activeTaskLimit, 2);

      const resumed = yield* service.resumePairing(created.detail.integration.integrationId);
      assert.notStrictEqual(resumed.pairingCode, created.pairingCode);
      const oldCredential = yield* Effect.flip(service.authenticate(`Bearer ${credential}`));
      assert.strictEqual(oldCredential._tag, "AgentControlExternalIntegrationError");
      assert.strictEqual(reasonOf(oldCredential), "credential-refused");

      yield* service.revoke(created.detail.integration.integrationId);
      const revoked = yield* Effect.flip(
        service.revalidate(created.detail.integration.integrationId),
      );
      assert.strictEqual(revoked._tag, "AgentControlExternalIntegrationError");
      assert.strictEqual(reasonOf(revoked), "revoked");
    }),
  );

  it.effect("refuses expired pairing codes and permits an explicit resume", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const repository = yield* AgentControlExternalRepository;
      const created = yield* service.create(createInput({ displayName: "Expiring client" }));
      const stored = Option.getOrThrow(
        yield* repository.getIntegration(created.detail.integration.integrationId),
      );
      yield* repository.replaceIntegration({
        ...stored,
        pairingCodeExpiresAt: "2020-01-01T00:00:00.000Z",
      });
      const expiredCode = yield* Effect.flip(
        service.exchangePairing({
          integrationId: stored.integrationId,
          pairingCode: created.pairingCode,
        }),
      );
      assert.strictEqual(reasonOf(expiredCode), "pairing-refused");

      const resumed = yield* service.resumePairing(stored.integrationId);
      yield* service.exchangePairing({
        integrationId: stored.integrationId,
        pairingCode: resumed.pairingCode,
      });
      assert.strictEqual((yield* service.revalidate(stored.integrationId)).pairingState, "paired");
    }),
  );

  it.effect("rate-limits before revealing capability or project-scope failures", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const created = yield* service.create(
        createInput({
          displayName: "Rate-limited client",
          capabilities: [AGENT_CONTROL_CAPABILITIES.externalReadTask],
          rateLimitPerMinute: 1,
        }),
      );
      yield* service.exchangePairing({
        integrationId: created.detail.integration.integrationId,
        pairingCode: created.pairingCode,
      });
      const denied = yield* Effect.flip(
        service.authorizeTool({
          integrationId: created.detail.integration.integrationId,
          tool: "ryco_create_task",
          requiredCapability: AGENT_CONTROL_CAPABILITIES.externalCreateTask,
          projectId: ProjectId.make("project-2"),
        }),
      );
      assert.strictEqual(reasonOf(denied), "capability-denied");

      const throttled = yield* Effect.flip(
        service.authorizeTool({
          integrationId: created.detail.integration.integrationId,
          tool: "ryco_create_task",
          requiredCapability: AGENT_CONTROL_CAPABILITIES.externalCreateTask,
          projectId: ProjectId.make("project-secret"),
        }),
      );
      assert.strictEqual(reasonOf(throttled), "rate-limited");
    }),
  );

  it.effect("expires credentials and deletes public integration state", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const created = yield* service.create(createInput({ displayName: "Temporary client" }));
      yield* service.update({
        integrationId: created.detail.integration.integrationId,
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
      const expired = yield* Effect.flip(
        service.revalidate(created.detail.integration.integrationId),
      );
      assert.strictEqual(reasonOf(expired), "expired");
      assert.isTrue((yield* service.delete(created.detail.integration.integrationId)).deleted);
      assert.notInclude(
        (yield* service.list()).integrations.map((detail) => detail.integration.integrationId),
        created.detail.integration.integrationId,
      );
    }),
  );
});
