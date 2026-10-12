/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload and boot deferral
 * ----------------------------
 * In every mode the layer reads `ServerSettings` once, publishes the
 * configured identities, and builds the drivers only after the HTTP listener
 * serves (see `ProviderInstanceRegistryHydrationLive`). A daemon fiber tied to
 * the layer scope then reconciles every `ServerSettingsService.streamChanges`
 * emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@ryco/contracts";
import { Cause, Context, Deferred, Effect, Layer, Ref, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { StartupStallMonitorLive, trackStartupPhase } from "../../startupStallMonitor.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "../builtInDrivers.ts";
import { ProviderInstanceBootGate } from "../Services/ProviderInstanceBootGate.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import {
  makeProviderInstanceRegistry,
  resolveConfiguredProviderIdentities,
} from "./ProviderInstanceRegistryLive.ts";

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

const logUnlessInterrupted =
  (message: string) =>
  <R>(effect: Effect.Effect<void, never, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(message, { cause: Cause.pretty(cause) }),
      ),
    );

const makeHydratedProviderInstanceRegistry = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const { registry, mutator } = yield* makeProviderInstanceRegistry({
    drivers: BUILT_IN_DRIVERS,
    configMap: {} as ProviderInstanceConfigMap,
  });

  const initialSettings: ServerSettings | undefined = yield* trackStartupPhase(
    "provider.settings.read",
    serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined)),
  );
  const initialConfigMap =
    initialSettings === undefined
      ? ({} as ProviderInstanceConfigMap)
      : deriveProviderInstanceConfigMap(initialSettings);
  const configuredIdentities = yield* resolveConfiguredProviderIdentities({
    drivers: BUILT_IN_DRIVERS,
    configMap: initialConfigMap,
  });
  const configuredInstanceIds = new Set(
    configuredIdentities.map((identity) => identity.instanceId),
  );
  yield* Effect.logInfo("provider instance registry hydration config resolved", {
    settingsLoaded: initialSettings !== undefined,
    explicitInstances: Object.keys(initialSettings?.providerInstances ?? {}).length,
    configuredInstances: Object.keys(initialConfigMap).length,
  });

  const reconcileSemaphore = yield* Semaphore.make(1);
  // Identities of the config map most recently handed to `reconcile`, published before its
  // drivers are built. Instances still being built stay configured; ones a settings change
  // removed (even before they were ever built) stop counting.
  const plannedIdentities = yield* Ref.make(configuredIdentities);
  const gateReleased = yield* Deferred.make<void>();
  const initialReconcileSettled = yield* Deferred.make<void>();
  // The config map is resolved under the permit, so a reconcile can never apply settings older
  // than the ones a previous reconcile already applied.
  const reconcile = (resolveConfigMap: Effect.Effect<ProviderInstanceConfigMap>) =>
    reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const configMap = yield* resolveConfigMap;
        yield* Ref.set(
          plannedIdentities,
          yield* resolveConfiguredProviderIdentities({ drivers: BUILT_IN_DRIVERS, configMap }),
        );
        yield* mutator.reconcile(configMap);
        return configMap;
      }),
    );

  // Later settings emissions also wait for the gate, so nothing builds drivers before the
  // listener serves. Emissions arrive in order, so the last one applied is the newest.
  yield* serverSettings.streamChanges.pipe(
    Stream.runForEach((next) =>
      Deferred.await(gateReleased).pipe(
        Effect.andThen(reconcile(Effect.succeed(deriveProviderInstanceConfigMap(next)))),
        Effect.asVoid,
        logUnlessInterrupted("ProviderInstanceRegistry reconcile failed"),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.gen(function* () {
    yield* Deferred.await(gateReleased);
    const startedAt = Date.now();
    // Settings may have changed since the boot read; build from the current ones.
    const configMap = yield* trackStartupPhase(
      "provider.instances.reconcile",
      reconcile(
        serverSettings.getSettings.pipe(
          Effect.map(deriveProviderInstanceConfigMap),
          Effect.orElseSucceed(() => initialConfigMap),
        ),
      ),
    );
    yield* Effect.logInfo("provider instance registry initial reconcile complete", {
      durationMs: Date.now() - startedAt,
      configuredInstances: Object.keys(configMap).length,
    });
  }).pipe(
    logUnlessInterrupted("ProviderInstanceRegistry initial reconcile failed"),
    Effect.ensuring(Deferred.succeed(initialReconcileSettled, undefined)),
    Effect.forkScoped,
  );

  const release = Deferred.succeed(gateReleased, undefined).pipe(Effect.asVoid);
  const awaitInitialReconcile = release.pipe(
    Effect.andThen(Deferred.await(initialReconcileSettled)),
  );

  const hydratedRegistry: ProviderInstanceRegistryShape = {
    // A consumer that needs a configured instance before the gate opens builds it now instead of
    // failing with "unknown instance" (e.g. provider intent recovery during startup).
    getInstance: (instanceId) =>
      registry
        .getInstance(instanceId)
        .pipe(
          Effect.flatMap((instance) =>
            instance !== undefined || !configuredInstanceIds.has(instanceId)
              ? Effect.succeed(instance)
              : awaitInitialReconcile.pipe(Effect.andThen(registry.getInstance(instanceId))),
          ),
        ),
    listInstances: registry.listInstances,
    listUnavailable: registry.listUnavailable,
    listConfigured: Ref.get(plannedIdentities),
    get streamChanges() {
      return registry.streamChanges;
    },
    get subscribeChanges() {
      return registry.subscribeChanges;
    },
  };

  return Context.make(ProviderInstanceRegistry, hydratedRegistry).pipe(
    Context.add(ProviderInstanceRegistryMutator, mutator),
    Context.add(ProviderInstanceBootGate, { release, awaitInitialReconcile }),
  );
});

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * Every mode starts the registry empty: building an instance imports its
 * provider SDK and can start helper processes, none of which may delay the
 * HTTP listener. The layer instead
 *   - reads settings once and exposes the configured identities through
 *     `listConfigured`, so `ProviderRegistry` serves persisted snapshots
 *     immediately without constructing drivers;
 *   - builds the configured instances when `ProviderInstanceBootGate.release`
 *     runs (the server releases it once the HTTP listener serves), or as soon
 *     as a consumer asks `getInstance` for a configured instance;
 *   - reconciles every later settings emission, skipping the initial build
 *     when a newer emission already superseded it.
 *
 * It also starts the startup stall monitor, the earliest provider-owned point
 * in the boot graph (the monitor layer is memoized, so a layer built earlier
 * can provide the same value and own it instead).
 */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceBootGate,
  never,
  BuiltInDriversEnv | ServerConfig | ServerSettingsService
> = Layer.merge(
  Layer.effectContext(makeHydratedProviderInstanceRegistry),
  StartupStallMonitorLive,
) as Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceBootGate,
  never,
  BuiltInDriversEnv | ServerConfig | ServerSettingsService
>;
