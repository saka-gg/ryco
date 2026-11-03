import { CopilotSettings, ProviderDriverKind, type ServerProvider } from "@ryco/contracts";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCopilotTextGeneration } from "../../textGeneration/CopilotTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCopilotAdapter } from "../Layers/CopilotAdapter.ts";
import {
  checkCopilotProviderStatus,
  makePendingCopilotProvider,
} from "../Layers/CopilotProvider.ts";
import { AgentProcessPriority } from "../agentProcessPriority.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeLazyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
} from "../providerMaintenance.ts";
import { makeProviderProbeFingerprint } from "../providerProbeFingerprint.ts";
import { AgentControlSessionRegistry } from "../../agentControl/Services/AgentControlSessionRegistry.ts";

const DRIVER_KIND = ProviderDriverKind.make("copilot");

/** The install script puts the CLI in `$PREFIX/bin`, `~/.local` for a non-root install. */
function isCopilotNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/copilot") || normalized.endsWith("/.local/bin/copilot.exe")
  );
}

// Ryco spawns the user's own `copilot` binary, so its install decides the update: script installs
// update themselves, the `copilot-cli` cask is found from its keg, and WinGet stays manual.
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@github/copilot",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isCopilotNativeCommandPath,
  },
});

export type CopilotDriverEnv =
  | AgentProcessPriority
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => Schema.decodeSync(CopilotSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processPriority = yield* AgentProcessPriority;
      const agentControl = yield* Effect.serviceOption(AgentControlSessionRegistry);
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;

      const adapter = yield* makeCopilotAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        processPriority,
        ...(Option.isSome(agentControl) ? { agentControl: agentControl.value } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCopilotTextGeneration(
        effectiveConfig,
        processEnv,
        undefined,
        { processPriority },
      );

      const checkProvider = checkCopilotProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
      );

      const maintenanceCapabilities = yield* makeLazyProviderMaintenanceCapabilities(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const probeFingerprint = yield* makeProviderProbeFingerprint({
        driverKind: DRIVER_KIND,
        binaryPaths: [effectiveConfig.binaryPath],
        env: processEnv,
        settings: { instanceId, displayName, accentColor, environment, config: effectiveConfig },
      });

      const snapshot = yield* makeManagedServerProvider<CopilotSettings>({
        maintenanceCapabilities,
        probeFingerprint,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingCopilotProvider(settings)),
        checkProvider,
        enrichSnapshot: ({ snapshot: currentSnapshot, publishSnapshot }) =>
          maintenanceCapabilities.pipe(
            Effect.flatMap((capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, capabilities),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ServerSettingsService, serverSettings),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: null,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Copilot snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
