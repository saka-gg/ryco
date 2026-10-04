import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  McpProviderCapabilities,
  McpSettingsError,
  McpWorkspace,
  McpWorkspaceId,
} from "@ryco/contracts";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { externalAgentControlConfigFingerprint } from "../../mcp/externalAgentControlEntry.ts";
import type { ProviderMcpRegistryShape } from "../../mcp/ProviderMcpRegistry.ts";
import { AgentControlExternalRepositoryLive } from "../../persistence/Layers/AgentControlExternal.ts";
import { AgentControlMcpInstallationRepositoryLive } from "../../persistence/Layers/AgentControlMcpInstallation.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readExternalCredentialFile } from "../ExternalMcp/runtimeFiles.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalIntegrationServiceLive } from "./AgentControlExternalIntegration.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlExternalTopologyLive } from "./AgentControlExternalTopology.ts";
import { makeAgentControlExternalInstallation } from "./AgentControlExternalInstallation.ts";

const capabilities = Schema.decodeSync(McpProviderCapabilities)({
  externalAgentControl: "available",
  automaticAgentControl: "available",
  scopes: ["user"],
});

const successfulProbe = { probe: async () => ({ toolNames: ["ryco_overview"] }) };

const workspace = Schema.decodeSync(McpWorkspace)({
  id: "codex:dGVzdA",
  driver: "codex",
  providerDisplayName: "Codex",
  displayPath: "/tmp/codex-test",
  nativeScope: "user",
  formatGeneration: "test-v1",
  capabilities,
  providerMetadata: {},
  sharedHomePath: "/tmp/codex-test",
  mode: "direct",
  selectedInstanceId: "codex",
  providerInstances: [{ instanceId: "codex" }],
});

function makeFakeRegistry() {
  let installedFingerprint: string | null = null;
  let failInstall = false;
  const desiredFingerprint = (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    externalAgentControlConfigFingerprint({
      transport: "stdio",
      command: input.command,
      args: input.args,
      env: {},
      envVars: [],
      httpHeaders: {},
      envHttpHeaders: {},
      enabled: true,
      enabledTools: [],
      disabledTools: [],
      oauthScopes: [],
    });
  const unused = (): Effect.Effect<never, McpSettingsError> => Effect.die("not used in test");
  const registry: ProviderMcpRegistryShape = {
    listWorkspaces: Effect.succeed({
      workspaces: [workspace],
      providers: [
        {
          instanceId: workspace.selectedInstanceId,
          driver: workspace.driver,
          displayName: "Codex",
          enabled: true,
          status: "managed",
          capabilities,
          workspaceId: workspace.id,
          message: "Managed in test.",
        },
      ],
      issues: [],
    }),
    listServers: unused,
    upsertServer: unused,
    setServerEnabled: unused,
    removeServer: unused,
    reloadServers: unused,
    startOauthLogin: unused,
    inspectExternalAgentControl: (input) => {
      if (installedFingerprint === null) {
        return Effect.succeed({ state: "absent", fingerprint: null });
      }
      const desired = desiredFingerprint(input);
      return Effect.succeed({
        state: installedFingerprint === desired ? "matching" : "different",
        fingerprint: installedFingerprint,
      });
    },
    installExternalAgentControl: (input) => {
      if (failInstall) {
        return Effect.fail(new McpSettingsError({ message: "injected install failure" }));
      }
      installedFingerprint = desiredFingerprint(input);
      return Effect.succeed({ fingerprint: installedFingerprint });
    },
    removeExternalAgentControl: (input) => {
      if (installedFingerprint !== input.expectedFingerprint) {
        return Effect.succeed({ removed: false, preservedUserChanges: true });
      }
      installedFingerprint = null;
      return Effect.succeed({ removed: true, preservedUserChanges: false });
    },
  };
  return {
    registry,
    failNextInstall: () => {
      failInstall = true;
    },
    allowInstall: () => {
      failInstall = false;
    },
    simulateUserEdit: () => {
      installedFingerprint = "f".repeat(64);
    },
  };
}

function testLayer(stateDir: string) {
  const config = Layer.succeed(ServerConfig, {
    host: "127.0.0.1",
    tailscaleServeEnabled: false,
    hubConnector: { enabled: false },
    stateDir,
  } as ServerConfigShape);
  const external = AgentControlExternalIntegrationServiceLive.pipe(
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlExternalRepositoryLive),
    Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
    Layer.provideMerge(AgentControlExternalTopologyLive),
  );
  return Layer.mergeAll(external, AgentControlMcpInstallationRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(config),
  );
}

describe("AgentControlExternalInstallation", () => {
  it("connects with safe defaults and preserves user-modified config on disconnect", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-installation-test-"));
    const fake = makeFakeRegistry();
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeAgentControlExternalInstallation(
            fake.registry,
            successfulProbe,
          );
          const connected = yield* service.connect({ workspaceId: workspace.id });
          const credential = yield* Effect.promise(() =>
            readExternalCredentialFile(stateDir, connected.installation.integrationId),
          );
          fake.simulateUserEdit();
          const disconnected = yield* service.disconnect(connected.installation.installationId);
          const integrationService = yield* AgentControlExternalIntegrationService;
          const integrations = yield* integrationService.list();
          return { connected, disconnected, credential, integrations };
        }).pipe(Effect.provide(testLayer(stateDir)), Effect.scoped),
      );

      expect(result.connected.installation.state).toBe("connected");
      expect(result.credential.credential).toMatch(/^rycoext_/);
      expect(JSON.stringify(result.connected)).not.toContain(result.credential.credential);
      expect(result.disconnected.installation).toMatchObject({
        state: "disconnected",
        ownsNativeConfig: false,
        preservedUserChanges: true,
      });
      expect(result.integrations.integrations[0]?.integration).toMatchObject({
        projectScope: { kind: "all" },
        rateLimitPerMinute: 60,
        activeTaskLimit: 1,
        revokedAt: expect.any(String),
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists repair-needed and resumes after a provider write failure", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-installation-repair-test-"));
    const fake = makeFakeRegistry();
    fake.failNextInstall();
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeAgentControlExternalInstallation(
            fake.registry,
            successfulProbe,
          );
          yield* Effect.flip(service.connect({ workspaceId: McpWorkspaceId.make(workspace.id) }));
          const failed = (yield* service.list()).installations[0]!;
          fake.allowInstall();
          const repaired = yield* service.repair(failed.installationId);
          return { failed, repaired };
        }).pipe(Effect.provide(testLayer(stateDir)), Effect.scoped),
      );

      expect(result.failed.state).toBe("repair-needed");
      expect(result.failed.lastError).not.toContain("injected install failure");
      expect(result.repaired.installation.state).toBe("connected");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not connect before a successful MCP handshake and recovers after restart", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "ryco-installation-probe-test-"));
    const fake = makeFakeRegistry();
    let probeAvailable = false;
    const probe = {
      probe: async () => {
        if (!probeAvailable) throw new Error("injected secret-bearing probe failure");
        return { toolNames: ["ryco_overview"] };
      },
    };
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const firstProcess = yield* makeAgentControlExternalInstallation(fake.registry, probe);
          yield* Effect.flip(firstProcess.connect({ workspaceId: workspace.id }));
          const failed = (yield* firstProcess.list()).installations[0]!;
          probeAvailable = true;
          const restartedProcess = yield* makeAgentControlExternalInstallation(
            fake.registry,
            probe,
          );
          yield* restartedProcess.recover;
          const recovered = (yield* restartedProcess.list()).installations[0]!;
          return { failed, recovered };
        }).pipe(Effect.provide(testLayer(stateDir)), Effect.scoped),
      );

      expect(result.failed).toMatchObject({
        state: "repair-needed",
        connectedAt: null,
        lastError: "The installed Agent Control bridge did not complete the MCP handshake.",
      });
      expect(JSON.stringify(result.failed)).not.toContain("secret-bearing");
      expect(result.recovered).toMatchObject({ state: "connected", lastError: null });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
