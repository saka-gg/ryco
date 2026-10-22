/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ServerProviderShape` for this instance;
 *   - `adapter`    — the Codex session/turn/approval runtime;
 *   - `textGeneration` — commit/PR/branch/title generation via `codex exec`.
 *
 * Each call to `create()` captures the `codexConfig` argument in closures
 * owned by the returned instance. Two instances created with different
 * `homePath`s (e.g. `codex_personal` + `codex_work`) therefore run with
 * fully independent Codex app-server processes and `CODEX_HOME`
 * environments — no shared mutable state.
 *
 * Resource lifecycle: `create()` runs in a scope handed in by the registry.
 * Closing that scope releases the adapter's child processes, the managed
 * snapshot's refresh fibre, and the text-generation binaries' transient
 * scratch files. The registry uses this to tear down an instance when its
 * `providerInstances` entry disappears or its config changes.
 *
 * @module provider/Drivers/CodexDriver
 */
import { CodexSettings, ProviderDriverKind, type ServerProvider } from "@ryco/contracts";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { AgentControlSessionRegistry } from "../../agentControl/Services/AgentControlSessionRegistry.ts";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "../Layers/CodexProvider.ts";
import { makeCodexStoredThreadReader } from "../Layers/CodexStoredThreadReader.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  mergeProviderInstanceEnvironment,
  normalizeProviderHomeEnvironment,
} from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeLazyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
} from "../providerMaintenance.ts";
import { makeProviderProbeFingerprint } from "../providerProbeFingerprint.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  codexContinuationIdentity,
  codexProcessEnvironment,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");
const CODEX_STANDALONE_SEGMENT = "/packages/standalone/";
const CODEX_STANDALONE_PATTERN = /[\\/]packages[\\/]standalone[\\/]/gi;

/**
 * The standalone installer links `~/.local/bin/codex` (Windows:
 * `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, a junction) into
 * `$CODEX_HOME/packages/standalone/…`, which the real path shows.
 */
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes(CODEX_STANDALONE_SEGMENT);
}

/** The `CODEX_HOME` a standalone install lives in, read from its real path. */
export function codexHomeFromStandaloneCommandPath(realCommandPath: string): string | null {
  let index = -1;
  for (const match of realCommandPath.matchAll(CODEX_STANDALONE_PATTERN)) {
    index = match.index;
  }
  return index > 0 ? realCommandPath.slice(0, index) : null;
}

/**
 * `codex update` replaces the standalone tree under `CODEX_HOME`, so it runs against the home
 * that tree lives in. Without a standalone path it gets the instance's explicitly selected shared
 * home (an auth-overlay shadow home only carries auth), or Codex's own default.
 */
export function makeCodexMaintenanceResolver(explicitSharedHomePath: string | undefined) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      env: (context) => {
        const codexHome =
          codexHomeFromStandaloneCommandPath(context.realCommandPath) ?? explicitSharedHomePath;
        return codexHome ? { CODEX_HOME: codexHome } : undefined;
      },
    },
  });
}

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
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

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => Schema.decodeSync(CodexSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = normalizeProviderHomeEnvironment(
        mergeProviderInstanceEnvironment(environment),
      );
      const homeLayout = yield* resolveCodexHomeLayout(config, processEnv);
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;
      // Sessions, history reads, probes and text generation all start Codex with this.
      const codexEnvironment = codexProcessEnvironment(homeLayout, processEnv);
      const maintenanceCapabilities = yield* makeLazyProviderMaintenanceCapabilities(
        makeCodexMaintenanceResolver(
          homeLayout.effectiveHomePath === undefined ? undefined : homeLayout.sharedHomePath,
        ),
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      );
      const probeFingerprint = yield* makeProviderProbeFingerprint({
        driverKind: DRIVER_KIND,
        binaryPaths: [effectiveConfig.binaryPath],
        env: processEnv,
        settings: { instanceId, displayName, accentColor, environment, config: effectiveConfig },
        authFiles: [
          path.join(homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath, "auth.json"),
        ],
      });

      // Agent Control is optional at driver level: resolved from ambient
      // context so test compositions without the registry keep working.
      // Absent registry ⇒ no lease bridge ⇒ sessions start without Agent
      // Control (and never claim its tools). The lease itself is further
      // gated on the server setting and listener health inside the
      // registry, so wiring the bridge is never sufficient on its own.
      const agentControl = yield* Effect.serviceOption(AgentControlSessionRegistry);
      if (Option.isNone(agentControl)) {
        yield* Effect.logDebug("Codex driver built without Agent Control session registry", {
          instanceId,
        });
      }

      // One read-only app-server per instance serves the adapter's history reads and the
      // status probe, so a probe while it is up starts no process. A change to the binary
      // (upgrade, removal) or to the login retires it at the next probe.
      const storedThreadReader = yield* makeCodexStoredThreadReader({
        binaryPath: effectiveConfig.binaryPath,
        cwd: process.cwd(),
        ...(effectiveConfig.homePath ? { homePath: effectiveConfig.homePath } : {}),
        environment: codexEnvironment,
        binaryIdentity: probeFingerprint,
      });

      // `makeCodexAdapter` and `makeCodexTextGeneration` have `never` error
      // channels at construction time — their failure modes are all on the
      // per-operation closures they return. No `mapError` wrapper is needed
      // here; the registry only has to worry about snapshot-build and
      // spawner-availability failures surfaced from `checkCodexProviderStatus`
      // below.
      const adapter = yield* makeCodexAdapter(effectiveConfig, {
        instanceId,
        environment: codexEnvironment,
        storedThreadReader,
        ...(Option.isSome(agentControl) ? { agentControl: agentControl.value } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, codexEnvironment);

      // Build a managed snapshot whose settings never change — mutations come
      // in as instance rebuilds from the registry rather than in-place
      // updates. Pre-provide `ChildProcessSpawner` so the check fits
      // `makeManagedServerProvider.checkProvider`'s `R = never`.
      const checkProvider = checkCodexProviderStatus(
        effectiveConfig,
        undefined,
        codexEnvironment,
        storedThreadReader,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshot = yield* makeManagedServerProvider<CodexSettings>({
        maintenanceCapabilities,
        probeFingerprint,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingCodexProvider(settings)),
        checkProvider,
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
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
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
