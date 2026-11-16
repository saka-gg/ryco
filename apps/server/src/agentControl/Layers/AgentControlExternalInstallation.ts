import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
  AgentControlMcpInstallationId,
  McpServerName,
  type AgentControlExternalClientKind,
  type AgentControlMcpInstallation,
  type AgentControlMcpInstallationConnectInput,
  type McpWorkspace,
} from "@ryco/contracts";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { externalAgentControlConfigFingerprint } from "../../mcp/externalAgentControlEntry.ts";
import type { ProviderMcpRegistryShape } from "../../mcp/ProviderMcpRegistry.ts";
import { ProviderMcpRegistryService } from "../../mcp/ProviderMcpRegistryService.ts";
import {
  AgentControlMcpInstallationRepository,
  type StoredAgentControlMcpInstallation,
} from "../../persistence/Services/AgentControlMcpInstallation.ts";
import {
  removeExternalCredentialFile,
  writeExternalCredentialFile,
} from "../ExternalMcp/runtimeFiles.ts";
import {
  probeExternalMcpCommand,
  type ExternalMcpProtocolProbeInput,
} from "../ExternalMcp/probe.ts";
import { AgentControlMcpInstallationError } from "../Errors.ts";
import {
  AgentControlExternalInstallationService,
  type AgentControlExternalInstallationServiceShape,
} from "../Services/AgentControlExternalInstallation.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";

const CONNECT_CAPABILITIES = [
  AGENT_CONTROL_CAPABILITIES.externalListProjects,
  AGENT_CONTROL_CAPABILITIES.externalCreateTask,
  AGENT_CONTROL_CAPABILITIES.externalReadTask,
] as const;
const CONNECT_RATE_LIMIT = 60;
const CONNECT_ACTIVE_TASK_LIMIT = 1;
const REPAIR_MESSAGE = "Installation did not complete. Use Repair to retry safely.";

const installationError = (
  reason: ConstructorParameters<typeof AgentControlMcpInstallationError>[0]["reason"],
  detail: string,
) => new AgentControlMcpInstallationError({ reason, detail });

const toPublic = (stored: StoredAgentControlMcpInstallation): AgentControlMcpInstallation => ({
  installationId: stored.installationId,
  integrationId: stored.integrationId,
  workspaceId: stored.workspaceId,
  driver: stored.driver,
  serverName: stored.serverName,
  state: stored.state,
  revision: stored.revision,
  lastError: stored.lastError,
  ownsNativeConfig: stored.ownsNativeConfig,
  preservedUserChanges: stored.preservedUserChanges,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  connectedAt: stored.connectedAt,
});

const clientKindFor = (workspace: McpWorkspace): AgentControlExternalClientKind => {
  if (workspace.driver === "codex") return "codex";
  if (workspace.driver === "claudeAgent") return "claude-code";
  return "generic-mcp";
};

export interface AgentControlExternalInstallationIo {
  readonly probe: (input: ExternalMcpProtocolProbeInput) => Promise<unknown>;
}

const defaultIo: AgentControlExternalInstallationIo = { probe: probeExternalMcpCommand };

export const makeAgentControlExternalInstallation = (
  registry: ProviderMcpRegistryShape,
  io: AgentControlExternalInstallationIo = defaultIo,
) =>
  Effect.gen(function* () {
    const repository = yield* AgentControlMcpInstallationRepository;
    const integrations = yield* AgentControlExternalIntegrationService;
    const config = yield* ServerConfig;
    const lock = yield* Semaphore.make(1);

    const get = (installationId: AgentControlMcpInstallationId) =>
      repository.get(installationId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(installationError("not-found", "Agent Control installation not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );

    const replace = (
      current: StoredAgentControlMcpInstallation,
      patch: Partial<StoredAgentControlMcpInstallation>,
    ) => {
      const next: StoredAgentControlMcpInstallation = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return repository
        .replace({ expectedRevision: current.revision, installation: next })
        .pipe(
          Effect.flatMap((replaced) =>
            replaced
              ? Effect.succeed(next)
              : Effect.fail(
                  installationError("conflict", "Installation state changed; refresh and retry."),
                ),
          ),
        );
    };

    const markRepairNeeded = (
      current: StoredAgentControlMcpInstallation,
      detail = REPAIR_MESSAGE,
    ) =>
      replace(current, { state: "repair-needed", lastError: detail }).pipe(
        Effect.catch(() => get(current.installationId)),
      );

    const writeCredential = (input: {
      readonly integrationId: StoredAgentControlMcpInstallation["integrationId"];
      readonly credential: Redacted.Redacted<string>;
      readonly pairedAt: string;
    }) =>
      Effect.tryPromise({
        try: () =>
          writeExternalCredentialFile(config.stateDir, {
            version: 1,
            integrationId: input.integrationId,
            audience: AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
            credential: Redacted.value(input.credential),
            pairedAt: input.pairedAt,
          }),
        catch: () => installationError("storage", "Failed to write the private bridge credential."),
      });

    const removeCredential = (integrationId: StoredAgentControlMcpInstallation["integrationId"]) =>
      Effect.tryPromise({
        try: () => removeExternalCredentialFile(config.stateDir, integrationId),
        catch: () =>
          installationError("storage", "Failed to remove the private bridge credential."),
      });

    const integrationDetail = (integrationId: StoredAgentControlMcpInstallation["integrationId"]) =>
      integrations.list().pipe(
        Effect.mapError(() =>
          installationError("storage", "Failed to read the external integration."),
        ),
        Effect.flatMap((result) => {
          const detail = result.integrations.find(
            (entry) => entry.integration.integrationId === integrationId,
          );
          return detail
            ? Effect.succeed(detail)
            : Effect.fail(installationError("not-found", "External integration not found."));
        }),
      );

    const verify = (current: StoredAgentControlMcpInstallation, command: string, args: string[]) =>
      Effect.gen(function* () {
        const inspected = yield* registry.inspectExternalAgentControl({
          workspaceId: current.workspaceId,
          name: current.serverName,
          command,
          args,
        });
        if (inspected.state !== "matching" || inspected.fingerprint === null) {
          return yield* Effect.fail(
            installationError("verification", "The provider MCP entry did not verify."),
          );
        }
        yield* integrations
          .revalidate(current.integrationId)
          .pipe(
            Effect.mapError(() =>
              installationError("verification", "The external integration did not verify."),
            ),
          );
        yield* Effect.tryPromise({
          try: () => io.probe({ command, args, cwd: config.cwd }),
          catch: () =>
            installationError(
              "verification",
              "The installed Agent Control bridge did not complete the MCP handshake.",
            ),
        });
        return inspected.fingerprint;
      });

    const repairUnlocked = (initial: StoredAgentControlMcpInstallation) =>
      Effect.gen(function* () {
        if (initial.state === "disconnected" || initial.state === "revoked") return initial;
        let current = initial;
        const detail = yield* integrationDetail(current.integrationId);
        if (detail.integration.revokedAt !== null) {
          return yield* replace(current, {
            state: "revoked",
            lastError: "The external integration is revoked.",
            ownsNativeConfig: false,
          });
        }
        const rotated = yield* integrations
          .rotateCredential(current.integrationId)
          .pipe(
            Effect.mapError(() =>
              installationError("storage", "Failed to rotate the private bridge credential."),
            ),
          );
        yield* writeCredential({
          integrationId: current.integrationId,
          credential: rotated.credential,
          pairedAt: new Date().toISOString(),
        });
        current = yield* replace(current, {
          state: "credential-written",
          lastError: null,
          preservedUserChanges: false,
        });
        const command = detail.setup.serveCommand.command;
        const args = [...detail.setup.serveCommand.args];
        const inspected = yield* registry.inspectExternalAgentControl({
          workspaceId: current.workspaceId,
          name: current.serverName,
          command,
          args,
        });
        let nativeFingerprint = inspected.fingerprint;
        if (inspected.state === "different") {
          return yield* Effect.fail(
            installationError(
              "conflict",
              "The provider MCP entry was modified. Ryco preserved the user version.",
            ),
          );
        }
        if (inspected.state === "absent") {
          const installed = yield* registry.installExternalAgentControl({
            workspaceId: current.workspaceId,
            name: current.serverName,
            command,
            args,
            expectedFingerprint: null,
          });
          nativeFingerprint = installed.fingerprint;
        }
        current = yield* replace(current, {
          state: "provider-written",
          desiredFingerprint: externalAgentControlConfigFingerprint({
            transport: "stdio",
            command,
            args,
            env: {},
            envVars: [],
            httpHeaders: {},
            envHttpHeaders: {},
            enabled: true,
            enabledTools: [],
            disabledTools: [],
            oauthScopes: [],
          }),
          nativeFingerprint,
          ownsNativeConfig: true,
        });
        current = yield* replace(current, { state: "verifying" });
        const verifiedFingerprint = yield* verify(current, command, args);
        return yield* replace(current, {
          state: "connected",
          nativeFingerprint: verifiedFingerprint,
          ownsNativeConfig: true,
          lastError: null,
          connectedAt: new Date().toISOString(),
        });
      }).pipe(
        Effect.catch((error) =>
          get(initial.installationId).pipe(
            Effect.flatMap((latest) =>
              markRepairNeeded(
                latest,
                Schema.is(AgentControlMcpInstallationError)(error) ? error.detail : REPAIR_MESSAGE,
              ),
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );

    const disconnectUnlocked = (initial: StoredAgentControlMcpInstallation) =>
      Effect.gen(function* () {
        if (initial.state === "disconnected") return initial;
        let current =
          initial.state === "disconnecting"
            ? initial
            : yield* replace(initial, { state: "disconnecting", lastError: null });
        yield* integrations
          .revoke(current.integrationId)
          .pipe(
            Effect.mapError(() =>
              installationError("storage", "Failed to revoke the external integration."),
            ),
          );
        let preservedUserChanges = false;
        if (current.ownsNativeConfig && current.nativeFingerprint !== null) {
          const removed = yield* registry.removeExternalAgentControl({
            workspaceId: current.workspaceId,
            name: current.serverName,
            expectedFingerprint: current.nativeFingerprint,
          });
          preservedUserChanges = removed.preservedUserChanges;
        }
        yield* removeCredential(current.integrationId);
        current = yield* replace(current, {
          state: "disconnected",
          ownsNativeConfig: false,
          preservedUserChanges,
          lastError: preservedUserChanges
            ? "The provider entry was modified and was preserved for manual cleanup."
            : null,
        });
        return current;
      }).pipe(
        Effect.catch((error) =>
          get(initial.installationId).pipe(
            Effect.flatMap((latest) => markRepairNeeded(latest)),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );

    const connectUnlocked = (input: AgentControlMcpInstallationConnectInput) =>
      Effect.gen(function* () {
        const existing = (yield* repository.list()).find(
          (entry) =>
            entry.workspaceId === input.workspaceId &&
            entry.state !== "disconnected" &&
            entry.state !== "revoked",
        );
        if (existing) {
          return existing.state === "connected" ? existing : yield* repairUnlocked(existing);
        }
        const discovery = yield* registry.listWorkspaces;
        const workspace = discovery.workspaces.find((entry) => entry.id === input.workspaceId);
        if (!workspace || workspace.capabilities.externalAgentControl !== "available") {
          return yield* Effect.fail(
            installationError(
              "unsupported",
              "This provider profile cannot be connected automatically.",
            ),
          );
        }
        const created = yield* integrations
          .createPaired({
            displayName:
              input.displayName ??
              `Ryco Agent Control (${workspace.providerDisplayName ?? workspace.driver})`,
            clientKind: clientKindFor(workspace),
            projectScope: input.projectScope ?? { kind: "all" },
            capabilities: input.capabilities ?? CONNECT_CAPABILITIES,
            rateLimitPerMinute: input.rateLimitPerMinute ?? CONNECT_RATE_LIMIT,
            activeTaskLimit: input.activeTaskLimit ?? CONNECT_ACTIVE_TASK_LIMIT,
            expiresAt: input.expiresAt ?? null,
          })
          .pipe(
            Effect.mapError(() =>
              installationError("storage", "Failed to create the external integration."),
            ),
          );
        // Failing anywhere between creating the integration and a stored installation row would
        // leave a paired integration nothing references; after the insert the row owns recovery.
        const prepared = yield* Effect.gen(function* () {
          const desired = {
            workspaceId: workspace.id,
            command: created.detail.setup.serveCommand.command,
            args: [...created.detail.setup.serveCommand.args],
          };
          const primary = yield* registry.inspectExternalAgentControl({
            ...desired,
            name: McpServerName.make("ryco"),
          });
          const selectedName =
            primary.state === "different"
              ? McpServerName.make("ryco-agent-control")
              : McpServerName.make("ryco");
          const selected =
            selectedName === "ryco"
              ? primary
              : yield* registry.inspectExternalAgentControl({ ...desired, name: selectedName });
          if (selected.state === "different") {
            return yield* Effect.fail(
              installationError(
                "conflict",
                "Both Ryco MCP server names are already used by unrelated provider entries.",
              ),
            );
          }
          const now = new Date().toISOString();
          const row: StoredAgentControlMcpInstallation = {
            installationId: AgentControlMcpInstallationId.make(crypto.randomUUID()),
            integrationId: created.detail.integration.integrationId,
            workspaceId: workspace.id,
            driver: workspace.driver,
            serverName: selectedName,
            state: "planned",
            desiredFingerprint: externalAgentControlConfigFingerprint({
              transport: "stdio",
              command: desired.command,
              args: desired.args,
              env: {},
              envVars: [],
              httpHeaders: {},
              envHttpHeaders: {},
              enabled: true,
              enabledTools: [],
              disabledTools: [],
              oauthScopes: [],
            }),
            nativeFingerprint: null,
            lastError: null,
            ownsNativeConfig: false,
            preservedUserChanges: false,
            revision: 0,
            createdAt: now,
            updatedAt: now,
            connectedAt: null,
          };
          const inserted = yield* repository.insert(row);
          if (!inserted) {
            return yield* Effect.fail(
              installationError("conflict", "This provider profile is already being connected."),
            );
          }
          return { desired, selected, selectedName, row } as const;
        }).pipe(
          Effect.onError(() =>
            integrations.revoke(created.detail.integration.integrationId).pipe(Effect.ignore),
          ),
        );
        const { desired, selected, selectedName } = prepared;
        let current: StoredAgentControlMcpInstallation = prepared.row;
        const now = current.createdAt;
        const run = Effect.gen(function* () {
          yield* writeCredential({
            integrationId: current.integrationId,
            credential: created.credential,
            pairedAt: created.detail.integration.pairedAt ?? now,
          });
          current = yield* replace(current, { state: "credential-written" });
          const installed =
            selected.state === "matching" && selected.fingerprint !== null
              ? { fingerprint: selected.fingerprint }
              : yield* registry.installExternalAgentControl({
                  ...desired,
                  name: selectedName,
                  expectedFingerprint: null,
                });
          current = yield* replace(current, {
            state: "provider-written",
            nativeFingerprint: installed.fingerprint,
            ownsNativeConfig: true,
          });
          current = yield* replace(current, { state: "verifying" });
          const verifiedFingerprint = yield* verify(current, desired.command, desired.args);
          return yield* replace(current, {
            state: "connected",
            nativeFingerprint: verifiedFingerprint,
            ownsNativeConfig: true,
            connectedAt: new Date().toISOString(),
          });
        });
        return yield* run.pipe(
          Effect.catch((error) =>
            markRepairNeeded(
              current,
              Schema.is(AgentControlMcpInstallationError)(error) ? error.detail : REPAIR_MESSAGE,
            ).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
      });

    const recover = repository.list().pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all.filter((entry) =>
            [
              "planned",
              "credential-written",
              "provider-written",
              "verifying",
              "repair-needed",
              "disconnecting",
            ].includes(entry.state),
          ),
          (entry) =>
            lock
              .withPermit(
                entry.state === "disconnecting" ? disconnectUnlocked(entry) : repairUnlocked(entry),
              )
              .pipe(Effect.ignore),
          { concurrency: 1 },
        ),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );

    yield* recover.pipe(Effect.delay("250 millis"), Effect.forkScoped);

    return {
      list: () =>
        repository.list().pipe(Effect.map((all) => ({ installations: all.map(toPublic) }))),
      connect: (input) =>
        lock
          .withPermit(connectUnlocked(input))
          .pipe(Effect.map((installation) => ({ installation: toPublic(installation) }))),
      repair: (installationId) =>
        lock
          .withPermit(get(installationId).pipe(Effect.flatMap(repairUnlocked)))
          .pipe(Effect.map((installation) => ({ installation: toPublic(installation) }))),
      disconnect: (installationId) =>
        lock
          .withPermit(get(installationId).pipe(Effect.flatMap(disconnectUnlocked)))
          .pipe(Effect.map((installation) => ({ installation: toPublic(installation) }))),
      recover,
    } satisfies AgentControlExternalInstallationServiceShape;
  });

const makeLive = Effect.gen(function* () {
  const registry = yield* ProviderMcpRegistryService;
  return yield* makeAgentControlExternalInstallation(registry);
});

export const AgentControlExternalInstallationServiceLive = Layer.effect(
  AgentControlExternalInstallationService,
  makeLive,
);
