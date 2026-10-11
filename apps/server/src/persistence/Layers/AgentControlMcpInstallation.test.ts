import {
  AGENT_CONTROL_CAPABILITIES,
  AgentControlIntegrationId,
  AgentControlMcpInstallationId,
  McpServerName,
  McpWorkspaceId,
  ProviderDriverKind,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  AgentControlExternalRepository,
  AgentControlExternalSecretHash,
  type StoredAgentControlExternalIntegration,
} from "../Services/AgentControlExternal.ts";
import {
  AgentControlMcpInstallationFingerprint,
  AgentControlMcpInstallationRepository,
  type StoredAgentControlMcpInstallation,
} from "../Services/AgentControlMcpInstallation.ts";
import { AgentControlExternalRepositoryLive } from "./AgentControlExternal.ts";
import { AgentControlMcpInstallationRepositoryLive } from "./AgentControlMcpInstallation.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    AgentControlExternalRepositoryLive,
    AgentControlMcpInstallationRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-08-19T00:00:00.000Z";

const integration = (
  integrationId: AgentControlIntegrationId,
): StoredAgentControlExternalIntegration => ({
  integrationId,
  displayName: "Ryco Agent Control",
  clientKind: "codex",
  projectScope: { kind: "all" },
  capabilities: [
    AGENT_CONTROL_CAPABILITIES.externalListProjects,
    AGENT_CONTROL_CAPABILITIES.externalCreateTask,
    AGENT_CONTROL_CAPABILITIES.externalReadTask,
  ],
  rateLimitPerMinute: 60,
  activeTaskLimit: 1,
  activeTaskCount: 0,
  expiresAt: null,
  revokedAt: null,
  pairingState: "paired",
  pairingCodeHash: null,
  pairingCodeExpiresAt: null,
  pairedAt: now,
  credentialAudience: "external-mcp",
  credentialHash: AgentControlExternalSecretHash.make(
    createHash("sha256").update(integrationId).digest("hex"),
  ),
  createdAt: now,
  updatedAt: now,
  lastUsedAt: null,
});

const installation = (
  integrationId: AgentControlIntegrationId,
  workspaceId: string,
  installationId: string,
  overrides: Partial<StoredAgentControlMcpInstallation> = {},
): StoredAgentControlMcpInstallation => ({
  installationId: AgentControlMcpInstallationId.make(installationId),
  integrationId,
  workspaceId: McpWorkspaceId.make(workspaceId),
  driver: ProviderDriverKind.make("codex"),
  serverName: McpServerName.make("ryco"),
  state: "planned",
  desiredFingerprint: AgentControlMcpInstallationFingerprint.make("b".repeat(64)),
  nativeFingerprint: null,
  lastError: null,
  ownsNativeConfig: false,
  preservedUserChanges: false,
  revision: 0,
  createdAt: now,
  updatedAt: now,
  connectedAt: null,
  ...overrides,
});

testLayer("AgentControlMcpInstallationRepository", (it) => {
  it.effect("persists lifecycle state and enforces compare-and-set revisions", () =>
    Effect.gen(function* () {
      const external = yield* AgentControlExternalRepository;
      const repository = yield* AgentControlMcpInstallationRepository;
      const integrationId = AgentControlIntegrationId.make("installation-integration-1");
      assert.isTrue(yield* external.insertIntegration(integration(integrationId)));
      assert.isTrue(
        yield* repository.insert(installation(integrationId, "codex:dGVzdDE", "installation-1")),
      );

      const stored = Option.getOrThrow(
        yield* repository.get(AgentControlMcpInstallationId.make("installation-1")),
      );
      assert.isFalse(stored.ownsNativeConfig);
      const connected = installation(integrationId, "codex:dGVzdDE", "installation-1", {
        state: "connected",
        revision: 1,
        nativeFingerprint: AgentControlMcpInstallationFingerprint.make("c".repeat(64)),
        ownsNativeConfig: true,
        connectedAt: now,
      });
      assert.isTrue(yield* repository.replace({ expectedRevision: 0, installation: connected }));
      assert.isFalse(yield* repository.replace({ expectedRevision: 0, installation: connected }));
      assert.isTrue(
        Option.getOrThrow(
          yield* repository.get(AgentControlMcpInstallationId.make("installation-1")),
        ).ownsNativeConfig,
      );
    }),
  );

  it.effect("allows only one active owner for a provider workspace and server name", () =>
    Effect.gen(function* () {
      const external = yield* AgentControlExternalRepository;
      const repository = yield* AgentControlMcpInstallationRepository;
      const integrationId = AgentControlIntegrationId.make("installation-integration-2");
      assert.isTrue(yield* external.insertIntegration(integration(integrationId)));
      const first = installation(integrationId, "codex:dGVzdDI", "installation-2a");
      assert.isTrue(yield* repository.insert(first));
      assert.isFalse(
        yield* repository.insert(installation(integrationId, "codex:dGVzdDI", "installation-2b")),
      );
      assert.isTrue(
        yield* repository.replace({
          expectedRevision: 0,
          installation: { ...first, state: "disconnected", revision: 1 },
        }),
      );
      assert.isTrue(
        yield* repository.insert(installation(integrationId, "codex:dGVzdDI", "installation-2b")),
      );
    }),
  );

  it.effect("stores fingerprints but never raw credential material", () =>
    Effect.gen(function* () {
      const external = yield* AgentControlExternalRepository;
      const repository = yield* AgentControlMcpInstallationRepository;
      const sql = yield* SqlClient.SqlClient;
      const integrationId = AgentControlIntegrationId.make("installation-integration-3");
      assert.isTrue(yield* external.insertIntegration(integration(integrationId)));
      assert.isTrue(
        yield* repository.insert(installation(integrationId, "codex:dGVzdDM", "installation-3")),
      );
      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM agent_control_mcp_installations
      `;
      assert.notInclude(JSON.stringify(rows), "rycoext_secret-canary");
      assert.notProperty(rows[0] ?? {}, "credential");
    }),
  );
});
import { createHash } from "node:crypto";
