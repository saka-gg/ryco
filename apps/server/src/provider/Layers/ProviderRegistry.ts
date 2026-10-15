/**
 * ProviderRegistryLive — aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ServerProviderShape`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ServerProviderShape`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * Probe policy
 * ------------
 * Building the registry never probes. The persisted snapshot of every
 * configured instance is published at once, before any driver exists. Each
 * probed snapshot is persisted with a fingerprint of its inputs (binary on
 * disk, settings, server build); when an instance's driver arrives and the
 * fingerprint still matches, the persisted snapshot is adopted as fresh and
 * no probe runs. Stale instances are probed only on demand: a client
 * subscribing to server config (`revalidateStale`) starts one background pass
 * with low concurrency and staggered starts, and explicit refreshes probe
 * immediately. Instances added or rebuilt by a later settings change are
 * probed right away, as before.
 *
 * @module ProviderRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { trackStartupPhase } from "../../startupStallMonitor.ts";
import {
  type ConfiguredProviderIdentity,
  ProviderInstanceRegistry,
} from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import {
  hydrateCachedProviderFromConfig,
  orderProviderSnapshots,
  type ProviderProbeFreshness,
  readProviderStatusCacheEntry,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderSnapshotSource } from "../builtInProviderCatalog.ts";
import { ignoreProviderBackgroundCause } from "../ignoreProviderBackgroundCause.ts";
import { BUNDLED_MODEL_MANIFEST, ModelManifest } from "../ModelManifest.ts";
import { applyProviderCompatibility } from "../providerCompatibility.ts";
import { configuredIdentityOfInstance } from "./ProviderInstanceRegistryLive.ts";

/** Explicit refreshes (refresh button, maintenance actions) probe this many instances at once. */
const PROVIDER_REFRESH_CONCURRENCY = 4;
/** Background revalidation never runs more probes (each a CLI process tree) at once. */
const PROVIDER_BACKGROUND_REVALIDATION_CONCURRENCY = 2;
/**
 * Spacing between background probe starts. The first probe also waits one interval, so the
 * client whose subscription requested the pass receives its config snapshot first.
 */
const PROVIDER_BACKGROUND_REVALIDATION_STAGGER = Duration.millis(250);

/**
 * Persisted freshness is only trusted for definitive probe outcomes. Warnings and errors (missing
 * CLI, unverified auth) are re-probed after a restart, so a fix outside Ryco is picked up.
 */
const isPersistableProbeOutcome = (provider: ServerProvider): boolean =>
  provider.status === "ready" || provider.status === "disabled";

interface RevalidationPassState {
  readonly running: Deferred.Deferred<void> | null;
  readonly rerun: boolean;
}

interface PersistedProviderSnapshot {
  readonly provider: ServerProvider;
  readonly probeFreshness: ProviderProbeFreshness | undefined;
}

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const mergeProviderModels = (
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  if (nextModels.length === 0 && previousModels.length > 0) {
    return previousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return [...mergedModels, ...previousModels.filter((model) => !nextSlugs.has(model.slug))];
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(previousProvider.models, nextProvider.models),
      };

export const mergeProviderSnapshots = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const mergedProviders = new Map(
    previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
  );

  for (const provider of nextProviders) {
    mergedProviders.set(
      snapshotInstanceKey(provider),
      mergeProviderSnapshot(mergedProviders.get(snapshotInstanceKey(provider)), provider),
    );
  }

  return orderProviderSnapshots([...mergedProviders.values()]);
};

export const selectProvidersByKind = (
  providers: ReadonlyArray<ServerProvider>,
  providerKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ServerProvider> =>
  providers.filter((provider) => providerKinds.has(provider.driver));

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  // The adapter capability is the single source of truth for revert support.
  return Effect.succeed(
    source.conversationRollback === undefined
      ? snapshot
      : { ...snapshot, supportsConversationRollback: source.conversationRollback === "native" },
  );
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  // Snapshot-only instances carry no adapter; their revert support stays unknown.
  ...(instance.adapter?.capabilities
    ? { conversationRollback: instance.adapter.capabilities.conversationRollback ?? "unsupported" }
    : {}),
  getSnapshot: instance.snapshot.getSnapshot,
  revalidate: instance.snapshot.revalidate,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
  ...(instance.snapshot.isFresh ? { isFresh: instance.snapshot.isFresh } : {}),
  ...(instance.snapshot.isProbeFresh ? { isProbeFresh: instance.snapshot.isProbeFresh } : {}),
  ...(instance.snapshot.probeFingerprint
    ? { probeFingerprint: instance.snapshot.probeFingerprint }
    : {}),
  ...(instance.snapshot.adoptPersistedSnapshot
    ? { adoptPersistedSnapshot: instance.snapshot.adoptPersistedSnapshot }
    : {}),
});

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Compatibility ratings read the manifest already in memory (never the network). Without the
    // service (tests) the bundled policies and the code-owned floors still apply.
    const manifestService = yield* Effect.serviceOption(ModelManifest);
    const currentManifest = Option.match(manifestService, {
      onNone: () => Effect.succeed(BUNDLED_MODEL_MANIFEST),
      onSome: (service) => service.current,
    });
    const registryScope = yield* Effect.scope;
    const compatibilityRefreshRunning = yield* Ref.make(false);

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.sliding<ReadonlyArray<ServerProvider>>(1),
      PubSub.shutdown,
    );

    // Boot: read the persisted snapshot of every configured instance before any driver exists
    // (the hydration layer builds drivers only after the HTTP listener serves). Registries
    // without deferral report their live instances instead.
    const configuredIdentities = yield* (
      instanceRegistry.listConfigured ??
        instanceRegistry.listInstances.pipe(
          Effect.map((instances) => instances.map(configuredIdentityOfInstance)),
        )
    );
    const readPersistedSnapshot = (identity: ConfiguredProviderIdentity) =>
      Effect.gen(function* () {
        // One cache file per configured instance. For the default instance of a built-in kind
        // the path equals the legacy `<kind>.json`. The payload must still carry a matching
        // instance id + driver kind; identity-less legacy payloads are discarded and replaced by
        // the first probe.
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: identity.instanceId,
        }).pipe(Effect.provideService(Path.Path, path));
        const entry = yield* readProviderStatusCacheEntry(filePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        if (entry === undefined) {
          return undefined;
        }
        const provider = hydrateCachedProviderFromConfig({
          cachedProvider: entry.provider,
          identity,
        });
        if (provider === undefined) {
          if (
            entry.provider.instanceId !== identity.instanceId ||
            entry.provider.driver !== identity.driverKind
          ) {
            yield* Effect.logWarning("provider status cache identity mismatch, ignoring", {
              path: filePath,
              instanceId: identity.instanceId,
              cachedInstanceId: entry.provider.instanceId ?? null,
              driver: identity.driverKind,
              cachedDriver: entry.provider.driver ?? null,
            });
          }
          return undefined;
        }
        return {
          provider,
          probeFreshness: entry.probeFreshness,
        } satisfies PersistedProviderSnapshot;
      });
    const persistedSnapshots = new Map<ProviderInstanceId, PersistedProviderSnapshot>();
    for (const persisted of yield* trackStartupPhase(
      "provider.status-cache.seed",
      Effect.forEach(configuredIdentities, readPersistedSnapshot, { concurrency: "unbounded" }),
    )) {
      if (persisted !== undefined) {
        persistedSnapshots.set(persisted.provider.instanceId, persisted);
      }
    }
    // Configured instances whose driver has not arrived yet. The first arrival of each adopts
    // or keeps its persisted snapshot instead of probing at boot.
    const awaitingBootArrival = new Set<ProviderInstanceId>(
      configuredIdentities.map((identity) => identity.instanceId),
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
    // The freshness record persisted with each instance's snapshots: set before every probe (so
    // publications that race the probe's return carry it) and on adoption.
    const probeFreshnessRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, ProviderProbeFreshness>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());

    // Live-source registry. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);
    // Commit the materialized list, disk cache and full-list stream in order.
    // This is separate from lifecycle synchronization, which calls upsertProviders.
    const publicationSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = (provider: ServerProvider) =>
      Effect.gen(function* () {
        // Persist every instance — the file name is the instance id, so
        // multi-instance setups (e.g. `codex_personal`, `codex_work`) each
        // get their own cache. We resolve the path fresh so snapshots
        // produced by newly-added instances post-boot still land on disk
        // without the aggregator holding a stale `cachePathByInstance`
        // entry.
        const key = snapshotInstanceKey(provider);
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: key,
        }).pipe(Effect.provideService(Path.Path, path));
        const probeFreshness = isPersistableProbeOutcome(provider)
          ? (yield* Ref.get(probeFreshnessRef)).get(key)
          : undefined;
        yield* writeProviderStatusCache({ filePath, provider, probeFreshness }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.tapError(Effect.logError),
          Effect.ignore,
        );
      });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
      },
    ) {
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );
      const manifest = yield* currentManifest;
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of nextProvidersWithUpdateState) {
            const key = snapshotInstanceKey(provider);
            updatedKeys.add(key);
            mergedProviders.set(
              key,
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(mergedProviders.get(key), provider),
            );
          }

          // Re-rate every provider, not just the updated ones: the manifest may have changed
          // since the others were rated. Structural equality keeps a no-op re-rating silent.
          const providers = orderProviderSnapshots([...mergedProviders.values()]).map((provider) =>
            applyProviderCompatibility(provider, manifest),
          );
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
      }

      return providers;
    }, publicationSemaphore.withPermits(1));

    /**
     * TTL-gated manifest refresh after a provider sync, then a re-rating of every snapshot.
     * `syncProvider` is the funnel for every driver, so users without Claude (whose probe is
     * the other refresh trigger) still pick up remote compatibility policies, and a manifest
     * swapped by any refresh is applied without waiting for each provider to re-probe. At most
     * one runs at a time; a sync skipped meanwhile is covered by the running re-rate.
     */
    const scheduleCompatibilityRefresh = Effect.gen(function* () {
      if (Option.isNone(manifestService)) {
        return;
      }
      if (yield* Ref.getAndSet(compatibilityRefreshRunning, true)) {
        return;
      }
      yield* manifestService.value.refreshIfStale.pipe(
        Effect.andThen(upsertProviders([], { persist: false })),
        Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
        ignoreProviderBackgroundCause("provider compatibility reclassification failed"),
        // syncProvider also runs from RPC fibers; the refresh must outlive them.
        Effect.forkIn(registryScope),
      );
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const providers = yield* upsertProviders([provider], options);
      yield* scheduleCompatibilityRefresh;
      return providers;
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
          }
          return next;
        });

        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        return yield* upsertProviders([matchingProvider], {
          persist: false,
        });
      },
    );

    /**
     * Run one probe of `providerSource`. The fingerprint is computed and recorded before the
     * probe starts, so every snapshot this probe publishes is persisted with it.
     */
    const probeSource = <A>(providerSource: ProviderSnapshotSource, probe: Effect.Effect<A>) =>
      Effect.gen(function* () {
        if (providerSource.probeFingerprint) {
          const fingerprint = yield* providerSource.probeFingerprint;
          const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* Ref.update(probeFreshnessRef, (previous) =>
            new Map(previous).set(providerSource.instanceId, { fingerprint, checkedAt }),
          );
        }
        return yield* trackStartupPhase(`provider.probe:${providerSource.instanceId}`, probe);
      });

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      return yield* probeSource(providerSource, providerSource.refresh).pipe(
        Effect.flatMap((nextProvider) =>
          correlateSnapshotWithSource(providerSource, nextProvider).pipe(
            Effect.flatMap(syncProvider),
          ),
        ),
      );
    });

    const isSourceFresh = (providerSource: ProviderSnapshotSource) =>
      providerSource.isFresh ?? Effect.succeed(false);

    // A usage-only re-read is no probe: it must not move the persisted probe record forward.
    const isSourceProbeFresh = (providerSource: ProviderSnapshotSource) =>
      providerSource.isProbeFresh ?? isSourceFresh(providerSource);

    const revalidateOneSource = Effect.fn("revalidateOneSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      const revalidated = (yield* isSourceProbeFresh(providerSource))
        ? providerSource.revalidate
        : probeSource(providerSource, providerSource.revalidate);
      return yield* revalidated.pipe(
        Effect.flatMap((nextProvider) =>
          correlateSnapshotWithSource(providerSource, nextProvider).pipe(
            Effect.flatMap(syncProvider),
          ),
        ),
      );
    });

    /**
     * One background pass: probe every stale live source, at most
     * `PROVIDER_BACKGROUND_REVALIDATION_CONCURRENCY` at a time, with starts spaced by
     * `PROVIDER_BACKGROUND_REVALIDATION_STAGGER`. Fresh sources cost nothing.
     */
    const revalidateStaleSourcesInBackground = Effect.gen(function* () {
      const sources = yield* getLiveSources;
      const stale = yield* Effect.filter(sources, (source) =>
        isSourceFresh(source).pipe(Effect.map((fresh) => !fresh)),
      );
      if (stale.length === 0) {
        return;
      }
      const passStartedAtMs = yield* Clock.currentTimeMillis;
      const staggerMs = Duration.toMillis(PROVIDER_BACKGROUND_REVALIDATION_STAGGER);
      yield* Effect.forEach(
        stale,
        (source, index) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              Effect.sleep(Math.max(0, passStartedAtMs + (index + 1) * staggerMs - nowMs)),
            ),
            Effect.andThen(revalidateOneSource(source)),
            ignoreProviderBackgroundCause(
              "provider background revalidation failed; preserving cached provider",
            ),
          ),
        { concurrency: PROVIDER_BACKGROUND_REVALIDATION_CONCURRENCY, discard: true },
      );
    });

    // Single-flight background revalidation owned by the registry scope (a disconnecting client
    // must not cancel probes other clients wait for). Clients that ask during a pass join it;
    // drivers that arrive during a pass queue exactly one more pass, which covers them.
    const revalidationDemandedRef = yield* Ref.make(false);
    const revalidationPassRef = yield* Ref.make<RevalidationPassState>({
      running: null,
      rerun: false,
    });

    const runRevalidationPasses = (done: Deferred.Deferred<void>): Effect.Effect<void> =>
      revalidateStaleSourcesInBackground.pipe(
        Effect.andThen(
          Ref.modify(revalidationPassRef, (state) =>
            state.rerun
              ? ([true, { running: done, rerun: false }] as const)
              : ([false, { running: null, rerun: false }] as const),
          ),
        ),
        Effect.flatMap((rerun) => (rerun ? runRevalidationPasses(done) : Effect.void)),
      );

    const requestBackgroundRevalidation = Effect.fn("requestBackgroundRevalidation")(
      function* (options: { readonly rerunIfRunning: boolean }) {
        yield* Ref.set(revalidationDemandedRef, true);
        const candidate = yield* Deferred.make<void>();
        const selection = yield* Ref.modify(
          revalidationPassRef,
          (
            state,
          ): readonly [
            { readonly done: Deferred.Deferred<void>; readonly start: boolean },
            RevalidationPassState,
          ] =>
            state.running !== null
              ? [
                  { done: state.running, start: false },
                  { running: state.running, rerun: state.rerun || options.rerunIfRunning },
                ]
              : [
                  { done: candidate, start: true },
                  { running: candidate, rerun: false },
                ],
        );
        if (selection.start) {
          yield* runRevalidationPasses(candidate).pipe(
            Effect.onExit((exit) =>
              Ref.update(revalidationPassRef, (state) =>
                state.running === candidate ? { running: null, rerun: false } : state,
              ).pipe(Effect.andThen(Deferred.done(candidate, Exit.asVoid(exit)))),
            ),
            Effect.forkIn(registryScope),
          );
        }
        return selection.done;
      },
    );

    const revalidateStale = Effect.fn("revalidateStale")(function* () {
      const done = yield* requestBackgroundRevalidation({ rerunIfRunning: false });
      yield* Deferred.await(done);
      return yield* Ref.get(providersRef);
    });

    const refreshAll = Effect.fn("refreshAll")(function* () {
      yield* Ref.set(revalidationDemandedRef, true);
      const sources = yield* getLiveSources;
      return yield* Effect.forEach(sources, (source) => refreshOneSource(source), {
        concurrency: PROVIDER_REFRESH_CONCURRENCY,
        discard: true,
      }).pipe(Effect.andThen(Ref.get(providersRef)));
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (instanceId: ProviderInstanceId, provider: ProviderDriverKind) {
      const instance = Array.from((yield* Ref.get(liveSubsRef)).values()).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      return instance
        ? yield* instance.snapshot.maintenanceCapabilities
        : makeManualProviderMaintenanceCapabilities(provider);
    });

    /**
     * First arrival of a configured instance's driver. Adopt the persisted snapshot when its
     * probe fingerprint still matches, so the instance counts as fresh without probing.
     * Otherwise keep the persisted snapshot as last-known state, or publish the driver's pending
     * placeholder when nothing was persisted; a demand probes it later.
     */
    const settleBootArrival = Effect.fn("settleBootArrival")(function* (
      source: ProviderSnapshotSource,
    ) {
      const persisted = persistedSnapshots.get(source.instanceId);
      persistedSnapshots.delete(source.instanceId);
      const persistedFreshness = persisted?.probeFreshness;
      if (
        persisted !== undefined &&
        persistedFreshness !== undefined &&
        source.probeFingerprint !== undefined &&
        source.adoptPersistedSnapshot !== undefined
      ) {
        const checkedAtMs = Date.parse(persistedFreshness.checkedAt);
        const fingerprint = yield* source.probeFingerprint;
        const adopted =
          Number.isFinite(checkedAtMs) &&
          fingerprint === persistedFreshness.fingerprint &&
          (yield* source.adoptPersistedSnapshot({ snapshot: persisted.provider, checkedAtMs }));
        if (adopted) {
          yield* Ref.update(probeFreshnessRef, (previous) =>
            new Map(previous).set(source.instanceId, persistedFreshness),
          );
          return;
        }
      }
      const current = yield* Ref.get(providersRef);
      if (current.some((provider) => provider.instanceId === source.instanceId)) {
        return;
      }
      const placeholder = yield* source.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(source, snapshot)),
      );
      yield* upsertProviders([placeholder], { persist: false });
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - settle the first arrival of each configured instance without
     *     probing (see `settleBootArrival`);
     *   - probe instances added or rebuilt by a later settings change and
     *     await the result, so callers observe the re-probed state after the
     *     mutation pipeline settles;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSources = () =>
      syncSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const instances = yield* instanceRegistry.listInstances;
          const unavailableProviders = yield* instanceRegistry.listUnavailable;
          const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
            instances.map((instance) => [instance.instanceId, instance] as const),
          );
          const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
          for (const provider of unavailableProviders) {
            knownInstanceIds.add(snapshotInstanceKey(provider));
          }
          const previousSubs = yield* Ref.get(liveSubsRef);

          // Carry over subscriptions for instances whose identity is
          // unchanged (reconcile treated them as no-op). Instances that
          // disappeared, or were rebuilt with a different reference,
          // fall through to the "newly-added" branch below.
          const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
          for (const [instanceId, previousInstance] of previousSubs) {
            const nextInstance = nextByInstance.get(instanceId);
            if (nextInstance !== undefined && nextInstance === previousInstance) {
              carriedOver.set(instanceId, previousInstance);
            }
          }

          // Collect new/rebuilt instances in `nextByInstance` insertion
          // order (which preserves settings-author order).
          const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
          for (const [instanceId, instance] of nextByInstance) {
            if (carriedOver.has(instanceId)) {
              continue;
            }
            newlyAdded.push([instanceId, instance] as const);
          }

          // Fork long-lived subscriptions to each new/rebuilt instance's
          // change stream BEFORE any probe runs, so every publish lands in
          // an active subscriber.
          for (const [, instance] of newlyAdded) {
            const source = buildSnapshotSource(instance);
            yield* Stream.runForEach(source.streamChanges, (provider) =>
              correlateSnapshotWithSource(source, provider).pipe(Effect.flatMap(syncProvider)),
            ).pipe(Effect.forkScoped);
          }

          const nextSubs = new Map(carriedOver);
          for (const [instanceId, instance] of newlyAdded) {
            nextSubs.set(instanceId, instance);
          }
          yield* Ref.set(liveSubsRef, nextSubs);

          if (newlyAdded.length > 0) {
            // A new or rebuilt instance invalidates its predecessor's recorded probe freshness.
            yield* Ref.update(probeFreshnessRef, (previous) => {
              const next = new Map(previous);
              for (const [instanceId] of newlyAdded) next.delete(instanceId);
              return next;
            });
          }

          const bootArrivals = newlyAdded.filter(([instanceId]) =>
            awaitingBootArrival.has(instanceId),
          );
          for (const [instanceId] of bootArrivals) awaitingBootArrival.delete(instanceId);
          // Configured instances whose drivers are still being built keep their persisted
          // snapshots; ones a settings change removed before they arrived are dropped.
          if (instanceRegistry.listConfigured !== undefined) {
            const configuredIds = new Set(
              (yield* instanceRegistry.listConfigured).map((identity) => identity.instanceId),
            );
            for (const instanceId of awaitingBootArrival) {
              if (!configuredIds.has(instanceId)) awaitingBootArrival.delete(instanceId);
            }
          }
          for (const instanceId of awaitingBootArrival) knownInstanceIds.add(instanceId);
          const settingsArrivals = newlyAdded.filter((arrival) => !bootArrivals.includes(arrival));

          yield* Effect.forEach(
            bootArrivals,
            ([, instance]) =>
              settleBootArrival(buildSnapshotSource(instance)).pipe(
                ignoreProviderBackgroundCause(
                  "provider registry could not settle a booted instance; preserving cached provider",
                ),
              ),
            { concurrency: "unbounded", discard: true },
          );
          // A client already asked for fresh providers before these drivers existed.
          if (bootArrivals.length > 0 && (yield* Ref.get(revalidationDemandedRef))) {
            yield* requestBackgroundRevalidation({ rerunIfRunning: true });
          }

          // Probe instances a settings change added or rebuilt. The result is
          // piped straight into `syncProvider`, so `providersRef` is
          // populated regardless of PubSub subscription timing. Failures are
          // logged and swallowed so one bad driver cannot wedge the registry.
          yield* Effect.forEach(
            settingsArrivals,
            ([, instance]) =>
              refreshOneSource(buildSnapshotSource(instance)).pipe(
                ignoreProviderBackgroundCause(
                  "provider registry instance refresh failed; preserving cached provider",
                ),
              ),
            { concurrency: PROVIDER_REFRESH_CONCURRENCY, discard: true },
          );

          yield* upsertProviders(unavailableProviders, {
            persist: false,
            replace: true,
          });

          // Drop aggregator state for instances that have disappeared —
          // otherwise the UI would keep rendering ghosts.
          const [previousProviders, providers] = yield* Ref.modify(
            providersRef,
            (previousProviders) => {
              const providers = orderProviderSnapshots(
                previousProviders.filter((provider) =>
                  knownInstanceIds.has(snapshotInstanceKey(provider)),
                ),
              );
              return [[previousProviders, providers] as const, providers];
            },
          );
          if (haveProvidersChanged(previousProviders, providers)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
          yield* Ref.update(maintenanceActionStatesRef, (previous) => {
            const next = new Map(previous);
            for (const instanceId of previous.keys()) {
              if (!knownInstanceIds.has(instanceId)) {
                next.delete(instanceId);
              }
            }
            return next;
          });
        }),
      );
    const syncLiveSourcesAndContinue = syncLiveSources().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    // Publish the persisted snapshots read at boot, rated against the current manifest. Nothing
    // is written back: these files are exactly what was just read.
    yield* upsertProviders(
      [...persistedSnapshots.values()].map((persisted) => persisted.provider),
      { publish: false, persist: false },
    );
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync: subscribe to every instance already present (registries without boot
    // deferral). These are boot arrivals too, so nothing probes here.
    yield* syncLiveSources();
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    return {
      getProviders: Ref.get(providersRef),
      revalidateStale: revalidateStale().pipe(Effect.catchCause(recoverRefreshFailure)),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);
