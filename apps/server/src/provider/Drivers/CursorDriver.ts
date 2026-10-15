/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent (`cursor-agent` / `agent`) runtime.
 *
 * Cursor exposes an ACP-based CLI. Model catalog and capability refreshes
 * happen during the managed provider status check via Cursor's
 * `list_available_models` extension method.
 *
 * Text generation is supported via the ACP runtime — `makeCursorTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/CursorDriver
 */
import { CursorSettings, ProviderDriverKind, type ServerProvider } from "@ryco/contracts";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { makeCursorTextGeneration } from "../../textGeneration/CursorTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  enrichCursorSnapshot,
} from "../Layers/CursorProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeProviderProbeFingerprint } from "../providerProbeFingerprint.ts";
import {
  cursorAgentCommandCandidates,
  makeCursorMaintenanceCapabilities,
  resolveCursorAgentCommand,
} from "../acp/CursorAgentCommand.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlSessionRegistry } from "../../agentControl/Services/AgentControlSessionRegistry.ts";

const DRIVER_KIND = ProviderDriverKind.make("cursor");

export type CursorDriverEnv =
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

export const CursorDriver: ProviderDriver<CursorSettings, CursorDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => Schema.decodeSync(CursorSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const agentControl = yield* Effect.serviceOption(AgentControlSessionRegistry);
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
        ...(Option.isSome(agentControl) ? { agentControl: agentControl.value } : {}),
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
      const probeFingerprint = yield* makeProviderProbeFingerprint({
        driverKind: DRIVER_KIND,
        binaryPaths: cursorAgentCommandCandidates(effectiveConfig.binaryPath),
        env: processEnv,
        settings: { instanceId, displayName, accentColor, environment, config: effectiveConfig },
      });

      const adapter = yield* makeCursorAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeCursorTextGeneration(effectiveConfig, processEnv);

      // Cursor updates itself with the command sessions and probes run, resolved on each read
      // (cheap, and rare) so installing `cursor-agent` later is picked up.
      const maintenanceCapabilities = resolveCursorAgentCommand(
        effectiveConfig.binaryPath,
        processEnv,
        { fresh: true },
      ).pipe(Effect.map(makeCursorMaintenanceCapabilities));

      const checkProvider = checkCursorProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<CursorSettings>({
        maintenanceCapabilities,
        probeFingerprint,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialCursorProviderSnapshot(settings)),
        checkProvider,
        // Model catalog and capabilities come exclusively from Cursor's
        // list_available_models extension method during provider checks.
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          maintenanceCapabilities.pipe(
            Effect.flatMap((capabilities) =>
              enrichCursorSnapshot({
                settings,
                snapshot: currentSnapshot,
                maintenanceCapabilities: capabilities,
                publishSnapshot,
                stampIdentity,
                httpClient,
                serverSettings,
              }),
            ),
          ),
        refreshInterval: null,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Cursor snapshot: ${cause.message ?? String(cause)}`,
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
