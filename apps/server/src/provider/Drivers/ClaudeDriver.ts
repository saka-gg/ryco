/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@ryco/contracts";
import { Cache, Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  refreshClaudeProviderUsage,
} from "../Layers/ClaudeProvider.ts";
import { makeCachedClaudeUsageProbe } from "../Layers/ClaudeUsage.ts";
import { AgentProcessPriority } from "../agentProcessPriority.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ModelManifest } from "../ModelManifest.ts";
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
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  resolveClaudeProbeAuthFiles,
} from "./ClaudeHome.ts";
import { AgentControlSessionRegistry } from "../../agentControl/Services/AgentControlSessionRegistry.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);
const USAGE_PROBE_TTL = Duration.seconds(60);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

// Homebrew installs (the `claude-code` and `claude-code@latest` casks) are found from the keg;
// WinGet and system packages (apt, dnf, apk) stay manual.
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
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

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => Schema.decodeSync(ClaudeSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processPriority = yield* AgentProcessPriority;
      // Optional so tests and stripped-down layer stacks fall back to the
      // bundled model catalog instead of failing driver construction.
      const modelManifest = yield* Effect.serviceOption(ModelManifest);
      const agentControl = yield* Effect.serviceOption(AgentControlSessionRegistry);
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      const maintenanceCapabilities = yield* makeLazyProviderMaintenanceCapabilities(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const probeFingerprint = yield* makeProviderProbeFingerprint({
        driverKind: DRIVER_KIND,
        binaryPaths: [effectiveConfig.binaryPath],
        env: processEnv,
        settings: { instanceId, displayName, accentColor, environment, config: effectiveConfig },
        authFiles: yield* resolveClaudeProbeAuthFiles(effectiveConfig, processEnv),
        // The probed model list comes from the (remotely refreshable) model manifest.
        ...(Option.isSome(modelManifest) ? { dynamicInputs: modelManifest.value.current } : {}),
      });
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const adapterOptions = {
        instanceId,
        environment: processEnv,
        processPriority,
        ...(Option.isSome(agentControl) ? { agentControl: agentControl.value } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv, {
        processPriority,
      });

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        processEnv,
      );
      const probeUsage = yield* makeCachedClaudeUsageProbe(USAGE_PROBE_TTL);

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
        processEnv,
        probeUsage,
        Option.getOrUndefined(modelManifest),
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<ClaudeSettings>({
        maintenanceCapabilities,
        probeFingerprint,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingClaudeProvider(settings)),
        checkProvider,
        // An adopted snapshot's usage is re-read alone: no `claude --version`, no SDK session.
        refreshUsage: (current) =>
          refreshClaudeProviderUsage(effectiveConfig, current, processEnv, probeUsage).pipe(
            Effect.provideService(Path.Path, path),
          ),
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          maintenanceCapabilities.pipe(
            Effect.flatMap((capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities),
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
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
