import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
  AGENT_CONTROL_EXTERNAL_PAIRING_CODE_TTL_MS,
  type AgentControlCapability,
  type AgentControlExternalIntegration,
  AgentControlIntegrationId,
  type ProjectId,
} from "@ryco/contracts";
import { Effect, Layer, Option, PubSub, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import {
  AgentControlExternalRepository,
  type AgentControlExternalAuditRecord,
  type StoredAgentControlExternalIntegration,
} from "../../persistence/Services/AgentControlExternal.ts";
import { AgentControlExternalIntegrationError } from "../Errors.ts";
import {
  generateAgentControlExternalCredential,
  generateAgentControlPairingCode,
  hashAgentControlExternalSecret,
  pairingCodeHash,
  parseExternalAuthorization,
} from "../externalCredential.ts";
import { currentExternalSetupRuntime, makeExternalIntegrationSetup } from "../externalSetup.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import {
  AgentControlExternalIntegrationService,
  type AgentControlExternalIntegrationServiceShape,
} from "../Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalTopologyService } from "../Services/AgentControlExternalTopology.ts";

const EXTERNAL_CAPABILITIES = new Set<AgentControlCapability>([
  AGENT_CONTROL_CAPABILITIES.externalListProjects,
  AGENT_CONTROL_CAPABILITIES.externalCreateTask,
  AGENT_CONTROL_CAPABILITIES.externalReadTask,
  AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
  AGENT_CONTROL_CAPABILITIES.externalFullAccess,
  AGENT_CONTROL_CAPABILITIES.externalReadAutomations,
  AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
  AGENT_CONTROL_CAPABILITIES.externalReadActivity,
  AGENT_CONTROL_CAPABILITIES.externalReadDiagnostics,
  AGENT_CONTROL_CAPABILITIES.externalReadThreads,
  AGENT_CONTROL_CAPABILITIES.externalReadReviews,
  AGENT_CONTROL_CAPABILITIES.externalReadFiles,
  AGENT_CONTROL_CAPABILITIES.externalReadWorkspaces,
  AGENT_CONTROL_CAPABILITIES.externalControlThreads,
  AGENT_CONTROL_CAPABILITIES.externalManageWorkspaces,
]);
const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_RETENTION_ROWS = 1_000;

const fail = (
  reason: ConstructorParameters<typeof AgentControlExternalIntegrationError>[0]["reason"],
): Effect.Effect<never, AgentControlExternalIntegrationError> =>
  Effect.fail(new AgentControlExternalIntegrationError({ reason }));

const toPublicIntegration = (
  stored: StoredAgentControlExternalIntegration,
): AgentControlExternalIntegration => ({
  integrationId: stored.integrationId,
  displayName: stored.displayName,
  clientKind: stored.clientKind,
  projectScope: stored.projectScope,
  capabilities: stored.capabilities,
  rateLimitPerMinute: stored.rateLimitPerMinute,
  activeTaskLimit: stored.activeTaskLimit,
  activeTaskCount: stored.activeTaskCount,
  expiresAt: stored.expiresAt,
  revokedAt: stored.revokedAt,
  pairingState: stored.pairingState,
  pairingCodeExpiresAt: stored.pairingCodeExpiresAt,
  pairedAt: stored.pairedAt,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  lastUsedAt: stored.lastUsedAt,
});

const projectAllowed = (
  integration: Pick<AgentControlExternalIntegration, "projectScope">,
  projectId: ProjectId,
): boolean =>
  integration.projectScope.kind === "all" ||
  integration.projectScope.projectIds.includes(projectId);

const makeAgentControlExternalIntegration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const policy = yield* AgentControlPolicy;
  const repository = yield* AgentControlExternalRepository;
  const changes = yield* PubSub.unbounded<AgentControlIntegrationId>();
  // Read per call: a standby Hub connector can take this process over.
  const topology = yield* AgentControlExternalTopologyService;
  const runtime = currentExternalSetupRuntime(config.stateDir);

  const requireSetupAvailable = Effect.gen(function* () {
    yield* policy.requireEnabled("external integration setup");
    if (!topology.current().available) return yield* fail("topology-unavailable");
  });

  const detailFor: AgentControlExternalIntegrationServiceShape["detailFor"] = (stored) => ({
    integration: toPublicIntegration(stored),
    setup: makeExternalIntegrationSetup({
      integrationId: stored.integrationId,
      clientKind: stored.clientKind,
      runtime,
    }),
    topology: topology.current(),
  });

  const getStored = (integrationId: AgentControlIntegrationId) =>
    repository.getIntegration(integrationId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => fail("not-found"),
          onSome: Effect.succeed,
        }),
      ),
    );

  const validateConfiguration = (input: {
    readonly capabilities: ReadonlyArray<AgentControlCapability>;
    readonly projectScope: AgentControlExternalIntegration["projectScope"];
    readonly expiresAt: string | null;
  }) =>
    Effect.gen(function* () {
      if (
        new Set(input.capabilities).size !== input.capabilities.length ||
        input.capabilities.some((capability) => !EXTERNAL_CAPABILITIES.has(capability))
      ) {
        return yield* fail("capability-denied");
      }
      if (input.projectScope.kind === "selected") {
        if (new Set(input.projectScope.projectIds).size !== input.projectScope.projectIds.length) {
          return yield* fail("project-denied");
        }
      }
      if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) {
        return yield* fail("expired");
      }
    });

  const list: AgentControlExternalIntegrationServiceShape["list"] = () =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("external integration list");
      const integrations = yield* repository.listIntegrations();
      return { integrations: integrations.map(detailFor), topology: topology.current() };
    });

  const create: AgentControlExternalIntegrationServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      yield* requireSetupAvailable;
      yield* validateConfiguration(input);
      const now = new Date();
      if (input.expiresAt !== null && input.expiresAt <= now.toISOString()) {
        return yield* fail("expired");
      }
      const integrationId = AgentControlIntegrationId.make(crypto.randomUUID());
      const pairingCode = generateAgentControlPairingCode();
      const stored: StoredAgentControlExternalIntegration = {
        integrationId,
        displayName: input.displayName,
        clientKind: input.clientKind,
        projectScope: input.projectScope,
        capabilities: input.capabilities,
        rateLimitPerMinute: input.rateLimitPerMinute,
        activeTaskLimit: input.activeTaskLimit,
        activeTaskCount: 0,
        expiresAt: input.expiresAt,
        revokedAt: null,
        pairingState: "pending",
        pairingCodeHash: pairingCodeHash(integrationId, pairingCode),
        pairingCodeExpiresAt: new Date(
          now.getTime() + AGENT_CONTROL_EXTERNAL_PAIRING_CODE_TTL_MS,
        ).toISOString(),
        pairedAt: null,
        credentialAudience: null,
        credentialHash: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastUsedAt: null,
      };
      const inserted = yield* repository.insertIntegration(stored);
      if (!inserted) return yield* fail("storage");
      yield* PubSub.publish(changes, integrationId);
      return { detail: detailFor(stored), pairingCode };
    });

  const createPaired: AgentControlExternalIntegrationServiceShape["createPaired"] = (input) =>
    Effect.gen(function* () {
      yield* requireSetupAvailable;
      yield* validateConfiguration(input);
      const now = new Date();
      if (input.expiresAt !== null && input.expiresAt <= now.toISOString()) {
        return yield* fail("expired");
      }
      const integrationId = AgentControlIntegrationId.make(crypto.randomUUID());
      const rawCredential = generateAgentControlExternalCredential();
      const stored: StoredAgentControlExternalIntegration = {
        integrationId,
        displayName: input.displayName,
        clientKind: input.clientKind,
        projectScope: input.projectScope,
        capabilities: input.capabilities,
        rateLimitPerMinute: input.rateLimitPerMinute,
        activeTaskLimit: input.activeTaskLimit,
        activeTaskCount: 0,
        expiresAt: input.expiresAt,
        revokedAt: null,
        pairingState: "paired",
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
        pairedAt: now.toISOString(),
        credentialAudience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
        credentialHash: hashAgentControlExternalSecret(rawCredential),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastUsedAt: null,
      };
      const inserted = yield* repository.insertIntegration(stored);
      if (!inserted) return yield* fail("storage");
      yield* PubSub.publish(changes, integrationId);
      return {
        detail: detailFor(stored),
        credential: Redacted.make(rawCredential),
      };
    });

  const update: AgentControlExternalIntegrationServiceShape["update"] = (input) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("external integration update");
      const current = yield* getStored(input.integrationId);
      const next: StoredAgentControlExternalIntegration = {
        ...current,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.clientKind === undefined ? {} : { clientKind: input.clientKind }),
        ...(input.projectScope === undefined ? {} : { projectScope: input.projectScope }),
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        ...(input.rateLimitPerMinute === undefined
          ? {}
          : { rateLimitPerMinute: input.rateLimitPerMinute }),
        ...(input.activeTaskLimit === undefined ? {} : { activeTaskLimit: input.activeTaskLimit }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        updatedAt: new Date().toISOString(),
      };
      if (next.activeTaskLimit < next.activeTaskCount) return yield* fail("capacity-exhausted");
      yield* validateConfiguration(next);
      const replaced = yield* repository.replaceIntegration(next);
      if (!replaced) return yield* fail("not-found");
      yield* PubSub.publish(changes, next.integrationId);
      return { integration: toPublicIntegration(next) };
    });

  const resumePairing: AgentControlExternalIntegrationServiceShape["resumePairing"] = (
    integrationId,
  ) =>
    Effect.gen(function* () {
      yield* requireSetupAvailable;
      const current = yield* getStored(integrationId);
      if (current.revokedAt !== null) return yield* fail("revoked");
      if (current.expiresAt !== null && current.expiresAt <= new Date().toISOString()) {
        return yield* fail("expired");
      }
      const now = new Date();
      const pairingCode = generateAgentControlPairingCode();
      const next: StoredAgentControlExternalIntegration = {
        ...current,
        pairingState: "pending",
        pairingCodeHash: pairingCodeHash(integrationId, pairingCode),
        pairingCodeExpiresAt: new Date(
          now.getTime() + AGENT_CONTROL_EXTERNAL_PAIRING_CODE_TTL_MS,
        ).toISOString(),
        pairedAt: null,
        credentialAudience: null,
        credentialHash: null,
        updatedAt: now.toISOString(),
      };
      yield* repository.replaceIntegration(next);
      yield* PubSub.publish(changes, integrationId);
      return { detail: detailFor(next), pairingCode };
    });

  const revoke: AgentControlExternalIntegrationServiceShape["revoke"] = (integrationId) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("external integration revoke");
      const current = yield* getStored(integrationId);
      if (current.revokedAt !== null) return { integration: toPublicIntegration(current) };
      const now = new Date().toISOString();
      const next: StoredAgentControlExternalIntegration = {
        ...current,
        revokedAt: now,
        pairingState: "unpaired",
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
        credentialAudience: null,
        credentialHash: null,
        updatedAt: now,
      };
      yield* repository.replaceIntegration(next);
      yield* PubSub.publish(changes, integrationId);
      return { integration: toPublicIntegration(next) };
    });

  const deleteIntegration: AgentControlExternalIntegrationServiceShape["delete"] = (
    integrationId,
  ) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("external integration delete");
      const current = yield* getStored(integrationId);
      if (current.activeTaskCount > 0) return yield* fail("capacity-exhausted");
      const deleted = yield* repository.deleteIntegration(integrationId);
      if (deleted) yield* PubSub.publish(changes, integrationId);
      return { deleted };
    });

  const validateStored = (stored: StoredAgentControlExternalIntegration) =>
    Effect.gen(function* () {
      yield* requireSetupAvailable;
      const now = new Date().toISOString();
      if (stored.revokedAt !== null) return yield* fail("revoked");
      if (stored.expiresAt !== null && stored.expiresAt <= now) return yield* fail("expired");
      if (
        stored.pairingState !== "paired" ||
        stored.credentialAudience !== AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE ||
        stored.credentialHash === null
      ) {
        return yield* fail("credential-refused");
      }
      return stored;
    });

  const exchangePairing: AgentControlExternalIntegrationServiceShape["exchangePairing"] = (input) =>
    Effect.gen(function* () {
      yield* requireSetupAvailable;
      const credential = generateAgentControlExternalCredential();
      const exchanged = yield* repository.exchangePairing({
        integrationId: input.integrationId,
        pairingCodeHash: pairingCodeHash(input.integrationId, input.pairingCode),
        credentialHash: hashAgentControlExternalSecret(credential),
        now: new Date().toISOString(),
      });
      if (!exchanged) return yield* fail("pairing-refused");
      yield* PubSub.publish(changes, input.integrationId);
      return { integrationId: input.integrationId, credential: Redacted.make(credential) };
    });

  const rotateCredential: AgentControlExternalIntegrationServiceShape["rotateCredential"] = (
    integrationId,
  ) =>
    Effect.gen(function* () {
      yield* requireSetupAvailable;
      const current = yield* getStored(integrationId);
      if (current.revokedAt !== null) return yield* fail("revoked");
      if (current.expiresAt !== null && current.expiresAt <= new Date().toISOString()) {
        return yield* fail("expired");
      }
      const credential = generateAgentControlExternalCredential();
      const now = new Date().toISOString();
      const next: StoredAgentControlExternalIntegration = {
        ...current,
        pairingState: "paired",
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
        pairedAt: now,
        credentialAudience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
        credentialHash: hashAgentControlExternalSecret(credential),
        updatedAt: now,
      };
      const replaced = yield* repository.replaceIntegration(next);
      if (!replaced) return yield* fail("not-found");
      yield* PubSub.publish(changes, integrationId);
      return { integrationId, credential: Redacted.make(credential) };
    });

  const authenticate: AgentControlExternalIntegrationServiceShape["authenticate"] = (header) =>
    Effect.gen(function* () {
      const credential = parseExternalAuthorization(header);
      if (credential === null) return yield* fail("credential-refused");
      const found = yield* repository.findByCredentialHash(
        hashAgentControlExternalSecret(credential),
      );
      if (Option.isNone(found)) return yield* fail("credential-refused");
      const stored = yield* validateStored(found.value);
      const now = new Date().toISOString();
      yield* repository.touchLastUsed({ integrationId: stored.integrationId, now });
      return { integration: { ...toPublicIntegration(stored), lastUsedAt: now, updatedAt: now } };
    });

  const revalidate: AgentControlExternalIntegrationServiceShape["revalidate"] = (integrationId) =>
    getStored(integrationId).pipe(Effect.flatMap(validateStored), Effect.map(toPublicIntegration));

  const appendAudit: AgentControlExternalIntegrationServiceShape["appendAudit"] = (record) => {
    const now = new Date();
    return repository
      .insertAudit({ auditId: crypto.randomUUID(), ...record, createdAt: now.toISOString() })
      .pipe(
        Effect.andThen(
          repository.pruneAudit({
            integrationId: record.integrationId,
            before: new Date(now.getTime() - AUDIT_RETENTION_MS).toISOString(),
            keepNewest: AUDIT_RETENTION_ROWS,
          }),
        ),
      );
  };

  const authorizeTool: AgentControlExternalIntegrationServiceShape["authorizeTool"] = (input) =>
    Effect.gen(function* () {
      const integration = yield* revalidate(input.integrationId);
      const now = new Date();
      const since = new Date(now.getTime() - 60_000).toISOString();
      const admitted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const count = yield* repository.countAuditSince({
              integrationId: input.integrationId,
              since,
            });
            if (count >= integration.rateLimitPerMinute) return false;
            yield* repository.insertAudit({
              auditId: crypto.randomUUID(),
              integrationId: input.integrationId,
              tool: input.tool,
              requestId: null,
              projectId: null,
              runtimeMode: null,
              environment: null,
              proposalId: null,
              operationId: null,
              threadId: null,
              outcome: "request-admitted",
              createdAt: now.toISOString(),
            });
            return true;
          }),
        )
        .pipe(
          Effect.mapError(() => new AgentControlExternalIntegrationError({ reason: "storage" })),
        );
      if (!admitted) return yield* fail("rate-limited");
      yield* repository.pruneAudit({
        integrationId: input.integrationId,
        before: new Date(now.getTime() - AUDIT_RETENTION_MS).toISOString(),
        keepNewest: AUDIT_RETENTION_ROWS,
      });
      // These checks intentionally happen after rate admission. A throttled caller
      // cannot use error timing to probe project or capability state.
      if (
        input.requiredCapability !== undefined &&
        !integration.capabilities.includes(input.requiredCapability)
      ) {
        return yield* fail("capability-denied");
      }
      if (input.projectId !== undefined && !projectAllowed(integration, input.projectId)) {
        return yield* fail("project-denied");
      }
      return integration;
    });

  return {
    list,
    create,
    createPaired,
    update,
    resumePairing,
    revoke,
    delete: deleteIntegration,
    exchangePairing,
    rotateCredential,
    authenticate,
    revalidate,
    authorizeTool,
    appendAudit,
    detailFor,
    subscribeChanges: PubSub.subscribe(changes),
  } satisfies AgentControlExternalIntegrationServiceShape;
});

export const AgentControlExternalIntegrationServiceLive = Layer.effect(
  AgentControlExternalIntegrationService,
  makeAgentControlExternalIntegration,
);
