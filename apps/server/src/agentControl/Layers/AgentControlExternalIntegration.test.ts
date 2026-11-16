import {
  AGENT_CONTROL_CAPABILITIES,
  type AgentControlExternalIntegrationCreateInput,
  ProjectId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

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

/**
 * Runs `afterRead` once, right after the next integration read returns its row and before the
 * caller sees it, so a test can land a concurrent write inside a read-modify-write window.
 */
const interleave: { afterRead: Effect.Effect<void> | undefined } = { afterRead: undefined };
const InterleavingRepositoryLive = Layer.effect(
  AgentControlExternalRepository,
  Effect.gen(function* () {
    const live = yield* AgentControlExternalRepository;
    return {
      ...live,
      getIntegration: (integrationId) =>
        Effect.tap(live.getIntegration(integrationId), () => {
          const afterRead = interleave.afterRead;
          interleave.afterRead = undefined;
          return afterRead ?? Effect.void;
        }),
    } satisfies typeof live;
  }),
).pipe(Layer.provide(AgentControlExternalRepositoryLive));

const interleavingLayer = it.layer(
  AgentControlExternalIntegrationServiceLive.pipe(
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(InterleavingRepositoryLive),
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
      const sql = yield* SqlClient.SqlClient;
      const created = yield* service.create(createInput({ displayName: "Expiring client" }));
      const stored = Option.getOrThrow(
        yield* repository.getIntegration(created.detail.integration.integrationId),
      );
      yield* sql`UPDATE agent_control_external_integrations
        SET pairing_code_expires_at = '2020-01-01T00:00:00.000Z'
        WHERE integration_id = ${stored.integrationId}`;
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

interleavingLayer("AgentControlExternalIntegrationService concurrent writes", (it) => {
  it.effect("keeps a task reservation made while an owner edit was in flight", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const repository = yield* AgentControlExternalRepository;
      const created = yield* service.createPaired(
        createInput({ displayName: "Busy client", activeTaskLimit: 2 }),
      );
      const integrationId = created.detail.integration.integrationId;
      interleave.afterRead = repository.reserveCapacity(integrationId).pipe(Effect.orDie);
      const updated = yield* service.update({ integrationId, displayName: "Renamed client" });
      assert.strictEqual(updated.integration.displayName, "Renamed client");
      assert.strictEqual(updated.integration.activeTaskCount, 1);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getIntegration(integrationId)).activeTaskCount,
        1,
      );
    }),
  );

  it.effect("refuses a limit below a reservation made while the edit was in flight", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const repository = yield* AgentControlExternalRepository;
      const created = yield* service.createPaired(
        createInput({ displayName: "Limited client", activeTaskLimit: 2 }),
      );
      const integrationId = created.detail.integration.integrationId;
      yield* repository.reserveCapacity(integrationId);
      interleave.afterRead = repository.reserveCapacity(integrationId).pipe(Effect.orDie);
      const refused = yield* Effect.flip(service.update({ integrationId, activeTaskLimit: 1 }));
      assert.strictEqual(reasonOf(refused), "capacity-exhausted");
      const stored = Option.getOrThrow(yield* repository.getIntegration(integrationId));
      assert.strictEqual(stored.activeTaskLimit, 2);
      assert.strictEqual(stored.activeTaskCount, 2);
    }),
  );

  it.effect("does not undo a revoke that lands during an owner edit", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const created = yield* service.createPaired(createInput({ displayName: "Edited client" }));
      const integrationId = created.detail.integration.integrationId;
      interleave.afterRead = service.revoke(integrationId).pipe(Effect.asVoid, Effect.orDie);
      const updated = yield* service.update({ integrationId, displayName: "Edited again" });
      assert.isNotNull(updated.integration.revokedAt);
      assert.strictEqual(
        reasonOf(yield* Effect.flip(service.revalidate(integrationId))),
        "revoked",
      );
      const credential = Redacted.value(created.credential);
      assert.strictEqual(
        reasonOf(yield* Effect.flip(service.authenticate(`Bearer ${credential}`))),
        "credential-refused",
      );
    }),
  );

  it.effect("does not re-arm an integration revoked during a credential rotation", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const created = yield* service.createPaired(createInput({ displayName: "Rotated client" }));
      const integrationId = created.detail.integration.integrationId;
      interleave.afterRead = service.revoke(integrationId).pipe(Effect.asVoid, Effect.orDie);
      const refused = yield* Effect.flip(service.rotateCredential(integrationId));
      assert.strictEqual(reasonOf(refused), "revoked");
      assert.strictEqual(
        reasonOf(yield* Effect.flip(service.revalidate(integrationId))),
        "revoked",
      );
    }),
  );

  it.effect("does not re-open pairing for an integration revoked during a resume", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlExternalIntegrationService;
      const repository = yield* AgentControlExternalRepository;
      const created = yield* service.create(createInput({ displayName: "Resumed client" }));
      const integrationId = created.detail.integration.integrationId;
      interleave.afterRead = service.revoke(integrationId).pipe(Effect.asVoid, Effect.orDie);
      const refused = yield* Effect.flip(service.resumePairing(integrationId));
      assert.strictEqual(reasonOf(refused), "revoked");
      const stored = Option.getOrThrow(yield* repository.getIntegration(integrationId));
      assert.strictEqual(stored.pairingState, "unpaired");
      assert.strictEqual(stored.pairingCodeHash, null);
    }),
  );
});
