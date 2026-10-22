/**
 * ProviderInstanceRegistryLive — runtime implementation of
 * `ProviderInstanceRegistry` plus its sibling mutator.
 *
 * Materializes every entry in a `ProviderInstanceConfigMap`:
 *
 *   - When the entry's `driver` matches a registered driver, the registry
 *     decodes the opaque `config` envelope through `driver.configSchema`
 *     and calls `driver.create()` inside a fresh child scope. The
 *     resulting `ProviderInstance` is stored keyed by instance id,
 *     alongside its scope so the entry can be torn down independently.
 *   - When the entry's `driver` is unknown to this build (fork, rollback,
 *     in-flight PR branch), the registry emits an `"unavailable"` shadow
 *     `ServerProvider` snapshot instead of failing. This is what makes
 *     downgrades and fork-hopping safe per the
 *     `forward/backward compatibility invariant` in
 *     `packages/contracts/src/providerInstance.ts`.
 *   - When the entry's config fails schema decode, the registry logs and
 *     emits a shadow snapshot with the schema detail — same bucket as an
 *     unknown driver.
 *
 * Unlike the pre-Slice-D layer, the registry now holds mutable state
 * (`Ref`s + `PubSub`) and exposes an internal mutator
 * (`ProviderInstanceRegistryMutator`) whose `reconcile` method diffs a
 * fresh config map against the live state, tearing down removed instances
 * and building new ones without disturbing unaffected instances.
 *
 * Every live instance runs inside its own child `Scope`. The registry's
 * own scope owns all child scopes through one parallel instances scope, so
 * closing the registry tears every instance down concurrently; closing a
 * single instance (via `reconcile` removing it) leaves the rest untouched.
 *
 * @module provider/Layers/ProviderInstanceRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@ryco/contracts";
import { Effect, Equal, Exit, PubSub, Ref, Schema, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { trackStartupPhase } from "../../startupStallMonitor.ts";
import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";
import type {
  ConfiguredProviderIdentity,
  ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstanceRegistryMutatorShape } from "../Services/ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "../ProviderDriver.ts";

/**
 * Live registry entry: the materialized `ProviderInstance` + the fresh
 * child scope its `create` effect ran in + the original `entry` envelope
 * so `reconcile` can cheaply detect "no-op" updates.
 */
interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

interface UnavailableEntry {
  readonly snapshot: ServerProvider;
  readonly entry: ProviderInstanceConfig;
}

/**
 * Internal state shared between the public registry service and the
 * mutator service. Both services are thin shells around these refs.
 */
interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, UnavailableEntry>>;
  readonly changes: PubSub.PubSub<void>;
}

type BuildEntryResult =
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider };

type ReconcileBuildPlan =
  | { readonly kind: "existing"; readonly instanceId: ProviderInstanceId; readonly live: LiveEntry }
  | {
      readonly kind: "existingUnavailable";
      readonly instanceId: ProviderInstanceId;
      readonly unavailable: UnavailableEntry;
    }
  | {
      readonly kind: "build";
      readonly instanceId: ProviderInstanceId;
      readonly rawInstanceId: string;
      readonly entry: ProviderInstanceConfig;
    };

type ReconcileBuildResult =
  | { readonly kind: "existing"; readonly instanceId: ProviderInstanceId; readonly live: LiveEntry }
  | {
      readonly kind: "existingUnavailable";
      readonly instanceId: ProviderInstanceId;
      readonly unavailable: UnavailableEntry;
    }
  | {
      readonly kind: "built";
      readonly instanceId: ProviderInstanceId;
      readonly entry: ProviderInstanceConfig;
      readonly result: BuildEntryResult;
    };

/**
 * Structural equality on `ProviderInstanceConfig` envelopes. Used by
 * `reconcile` to skip rebuilds when settings arrive unchanged. Config
 * payloads are opaque `unknown` at the envelope layer; `Equal.equals`
 * falls back to structural equality for plain records, which matches how
 * the schema decode output is constructed.
 */
const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

const orderChanged = <A>(previousOrder: ReadonlyArray<A>, nextOrder: ReadonlyArray<A>): boolean => {
  if (previousOrder.length !== nextOrder.length) {
    return true;
  }
  for (let i = 0; i < previousOrder.length; i++) {
    if (previousOrder[i] !== nextOrder[i]) {
      return true;
    }
  }
  return false;
};

const decodedConfigEnabled = (config: unknown): boolean | undefined => {
  if (!config || typeof config !== "object" || globalThis.Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/** Decode an envelope's opaque config; the single decode path for builds and boot seeding. */
const decodeInstanceConfig = <R>(driver: AnyProviderDriver<R>, entry: ProviderInstanceConfig) =>
  Schema.decodeUnknownEffect(driver.configSchema)(entry.config ?? driver.defaultConfig()).pipe(
    Effect.result,
  );

const resolveInstanceEnabled = (entry: ProviderInstanceConfig, typedConfig: unknown): boolean =>
  entry.enabled ?? decodedConfigEnabled(typedConfig) ?? true;

/** The configured identity of a built instance. */
export const configuredIdentityOfInstance = (
  instance: ProviderInstance,
): ConfiguredProviderIdentity => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  displayName: instance.displayName,
  accentColor: instance.accentColor,
  enabled: instance.enabled,
});

/**
 * Identities of the configured instances `reconcile(configMap)` would build, without building
 * them. Unknown drivers and undecodable configs are omitted; they surface as unavailable shadows
 * once the registry reconciles.
 */
export const resolveConfiguredProviderIdentities = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<ReadonlyArray<ConfiguredProviderIdentity>> =>
  Effect.gen(function* () {
    const driversById = new Map(input.drivers.map((driver) => [driver.driverKind, driver]));
    const identities: Array<ConfiguredProviderIdentity> = [];
    for (const [rawInstanceId, entry] of Object.entries(input.configMap)) {
      const driver = driversById.get(entry.driver);
      if (!driver) continue;
      const decoded = yield* decodeInstanceConfig(driver, entry);
      if (decoded._tag === "Failure") continue;
      identities.push({
        instanceId: ProviderInstanceId.make(rawInstanceId),
        driverKind: entry.driver,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        enabled: resolveInstanceEnabled(entry, decoded.success),
      });
    }
    return identities;
  });

/**
 * Build one live entry from a raw config envelope. Returns either a
 * `LiveEntry` plus undefined unavailable shadow, or a shadow snapshot and
 * undefined entry — callers dispatch to the appropriate Ref bucket.
 */
const buildEntry = <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
}): Effect.Effect<BuildEntryResult, never, R> =>
  Effect.gen(function* () {
    const { driversById, parentScope, instanceId, rawInstanceId, entry } = input;
    const startedAt = Date.now();
    const driver = driversById.get(entry.driver);
    if (!driver) {
      yield* Effect.logInfo("provider instance registry entry resolved", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        outcome: "unavailable",
        reason: "driver-not-registered",
        durationMs: Date.now() - startedAt,
      });
      return {
        kind: "unavailable" as const,
        snapshot: buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' is not registered in this build.`,
        }),
      };
    }

    const decodeResult = yield* decodeInstanceConfig(driver, entry);
    if (decodeResult._tag === "Failure") {
      const issue = decodeResult.failure;
      const detail = issue.message ?? String(issue);
      yield* Effect.logError("Failed to decode provider instance config", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail,
        durationMs: Date.now() - startedAt,
      });
      yield* Effect.logInfo("provider instance registry entry resolved", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        outcome: "unavailable",
        reason: "invalid-config",
        durationMs: Date.now() - startedAt,
      });
      return {
        kind: "unavailable" as const,
        snapshot: buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
        }),
      };
    }

    const typedConfig = decodeResult.success;
    // A child of the registry's instances scope: closing the registry closes
    // every surviving instance (in parallel, see `makeProviderInstanceRegistry`).
    // `reconcile` closes it directly on remove/replace, which also detaches it
    // from the parent, so replaced instances leave no finalizer behind.
    const childScope = yield* Scope.fork(parentScope);

    const enabled = resolveInstanceEnabled(entry, typedConfig);
    const createResult = yield* trackStartupPhase(
      `provider.instance.create:${rawInstanceId}`,
      driver.create({
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        environment: entry.environment ?? [],
        enabled,
        config: typedConfig,
      }),
    ).pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
    if (createResult._tag === "Failure") {
      yield* Effect.logError("Failed to create provider instance", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail: createResult.failure.detail,
        durationMs: Date.now() - startedAt,
      });
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
      yield* Effect.logInfo("provider instance registry entry resolved", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        outcome: "unavailable",
        reason: "create-failed",
        durationMs: Date.now() - startedAt,
      });
      return {
        kind: "unavailable" as const,
        snapshot: buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' failed to create instance: ${createResult.failure.detail}`,
        }),
      };
    }

    yield* Effect.logInfo("provider instance registry entry resolved", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      outcome: "live",
      enabled,
      durationMs: Date.now() - startedAt,
    });

    return {
      kind: "live" as const,
      live: {
        instance: createResult.success,
        scope: childScope,
        entry,
      },
    };
  });

/**
 * Reconcile-only implementation of the mutator. Exposed to the hydration
 * layer; never called directly by the rest of the server.
 */
const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
}): ((configMap: ProviderInstanceConfigMap) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope } = input;
  return (configMap: ProviderInstanceConfigMap) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );

      // 1. Close scopes for instances that disappeared or whose config
      //    changed. Do this BEFORE creating replacements so ids map 1-to-1
      //    to live scopes at all times.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      for (const [instanceId, live] of previousEntries) {
        if (!nextKeys.has(instanceId)) {
          removedIds.push(instanceId);
          continue;
        }
        const nextEntry = configMap[instanceId];
        if (nextEntry !== undefined && !entryEqual(live.entry, nextEntry)) {
          replacedIds.add(instanceId);
        }
      }
      yield* Effect.forEach(
        [...removedIds, ...replacedIds],
        (id) => {
          const live = previousEntries.get(id);
          return live ? Scope.close(live.scope, Exit.void).pipe(Effect.ignore) : Effect.void;
        },
        { concurrency: "unbounded", discard: true },
      );

      // 2. Build additions and replacements. Walk `nextRaw` so the final
      //    entry order follows settings-author order.
      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, UnavailableEntry>();

      const buildPlans: ReadonlyArray<ReconcileBuildPlan> = nextRaw.map(
        ([rawInstanceId, entry]) => {
          const instanceId = ProviderInstanceId.make(rawInstanceId);

          const existing = previousEntries.get(instanceId);
          if (existing !== undefined && !replacedIds.has(instanceId)) {
            // No-op update: keep the existing live entry and scope.
            return {
              kind: "existing" as const,
              instanceId,
              live: existing,
            };
          }

          const existingUnavailable = previousUnavailable.get(instanceId);
          if (existingUnavailable !== undefined && entryEqual(existingUnavailable.entry, entry)) {
            return {
              kind: "existingUnavailable" as const,
              instanceId,
              unavailable: existingUnavailable,
            };
          }

          return {
            kind: "build" as const,
            instanceId,
            rawInstanceId,
            entry,
          };
        },
      );

      const buildResults: ReadonlyArray<ReconcileBuildResult> = yield* Effect.forEach(
        buildPlans,
        (plan): Effect.Effect<ReconcileBuildResult, never, R> => {
          if (plan.kind === "existing") {
            return Effect.succeed({
              kind: "existing",
              instanceId: plan.instanceId,
              live: plan.live,
            });
          }

          if (plan.kind === "existingUnavailable") {
            return Effect.succeed({
              kind: "existingUnavailable",
              instanceId: plan.instanceId,
              unavailable: plan.unavailable,
            });
          }

          return buildEntry({
            driversById,
            parentScope,
            instanceId: plan.instanceId,
            rawInstanceId: plan.rawInstanceId,
            entry: plan.entry,
          }).pipe(
            Effect.map((result) => ({
              kind: "built" as const,
              instanceId: plan.instanceId,
              entry: plan.entry,
              result,
            })),
          );
        },
        { concurrency: "unbounded" },
      );

      let reusedInstances = 0;
      let createdInstances = 0;
      let unavailableInstances = 0;
      for (const result of buildResults) {
        if (result.kind === "existing") {
          reusedInstances++;
          builtEntries.set(result.instanceId, result.live);
          continue;
        }

        if (result.kind === "existingUnavailable") {
          reusedInstances++;
          unavailableInstances++;
          builtUnavailable.set(result.instanceId, result.unavailable);
          continue;
        }

        if (result.result.kind === "live") {
          createdInstances++;
          builtEntries.set(result.instanceId, result.result.live);
        } else {
          unavailableInstances++;
          builtUnavailable.set(result.instanceId, {
            snapshot: result.result.snapshot,
            entry: result.entry,
          });
        }
      }

      const entriesOrderChanged = orderChanged(
        [...previousEntries.keys()],
        [...builtEntries.keys()],
      );
      const unavailableOrderChanged = orderChanged(
        [...previousUnavailable.keys()],
        [...builtUnavailable.keys()],
      );

      const entriesChanged =
        entriesOrderChanged ||
        removedIds.length > 0 ||
        replacedIds.size > 0 ||
        builtEntries.size !== previousEntries.size;
      const unavailableChanged =
        unavailableOrderChanged ||
        builtUnavailable.size !== previousUnavailable.size ||
        [...builtUnavailable].some(([id, unavailable]) => {
          const prev = previousUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev.snapshot, unavailable.snapshot);
        }) ||
        [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

      yield* Ref.set(state.entries, builtEntries);
      yield* Ref.set(state.unavailable, builtUnavailable);

      if (entriesChanged || unavailableChanged) {
        yield* PubSub.publish(state.changes, undefined);
      }

      yield* Effect.logInfo("provider instance registry reconcile complete", {
        durationMs: Date.now() - startedAt,
        configuredInstances: nextRaw.length,
        reusedInstances,
        createdInstances,
        unavailableInstances,
        removedInstances: removedIds.length,
        replacedInstances: replacedIds.size,
        entriesChanged,
        unavailableChanged,
      });
    });
};

/**
 * Build the registry's runtime state from a concrete configMap. Returns a
 * record containing:
 *
 *   - `registry`: the read-only `ProviderInstanceRegistryShape` to expose
 *     under `ProviderInstanceRegistry`.
 *   - `mutator`: the `ProviderInstanceRegistryMutatorShape` to expose
 *     under `ProviderInstanceRegistryMutator`.
 *   - `reconcile`: the raw reconcile function, provided for convenience so
 *     boot-time layers can hydrate an initial map before publishing the
 *     services.
 *
 * The scope that this effect runs in owns every per-instance child scope
 * created during `reconcile`. Closing that scope closes every live
 * instance.
 */
export const makeProviderInstanceRegistry = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  {
    readonly registry: ProviderInstanceRegistryShape;
    readonly mutator: ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );

    // Capture the enclosing scope so per-instance child scopes can be
    // attached to it at `reconcile` time. Without this, `reconcile`
    // called later (e.g. from the hydration layer) would attach child
    // scopes to the *caller's* scope instead of the registry's.
    const parentScope = yield* Scope.Scope;

    // Capture the driver R context at construction time so `reconcile`
    // can be invoked later without re-providing driver dependencies.
    // The service tag's declared `reconcile: Effect<void>` hides R from
    // consumers — we materialize that here.
    const driverContext = yield* Effect.context<R>();

    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
    const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, UnavailableEntry>>(
      new Map(),
    );
    const changes = yield* PubSub.sliding<void>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    // Every instance scope hangs off this one, which finalizes its children in
    // parallel: server shutdown pays for the slowest provider teardown (child
    // process exits, SDK stops), not the sum of all of them. Forked after the
    // PubSub finalizer so instances still close before `changes` shuts down.
    const instancesScope = yield* Scope.fork(parentScope, "parallel");

    const state: RegistryState = { entries, unavailable, changes };
    const reconcileWithR = makeReconcile({ state, driversById, parentScope: instancesScope });
    const reconcileSemaphore = yield* Semaphore.make(1);
    const reconcile: ProviderInstanceRegistryMutatorShape["reconcile"] = (configMap) =>
      reconcileSemaphore
        .withPermits(1)(reconcileWithR(configMap))
        .pipe(Effect.provideContext(driverContext));

    // Hydrate the initial configMap synchronously so callers can read
    // `listInstances` immediately after this effect completes.
    yield* reconcile(input.configMap);

    const registry: ProviderInstanceRegistryShape = {
      getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
      listInstances: Ref.get(entries).pipe(
        Effect.map(
          (map) =>
            Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
        ),
      ),
      listUnavailable: Ref.get(unavailable).pipe(
        Effect.map(
          (map) =>
            Array.from(map.values(), (entry) => entry.snapshot) as ReadonlyArray<ServerProvider>,
        ),
      ),
      // Getters: each read constructs a fresh Stream / Effect descriptor
      // so multiple consumers don't share a single already-started
      // Channel or subscription. Matches the pattern `ProviderRegistry`
      // uses for its own `streamChanges`.
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      // Synchronous subscribe — callers that need to consume changes
      // from a forked fibre must acquire the subscription in their own
      // fibre first (via `yield* registry.subscribeChanges`) and only
      // then fork a consumer loop on `Stream.fromSubscription(...)` /
      // `PubSub.take(...)`. See the shape docs for the race this avoids.
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    };

    const mutator: ProviderInstanceRegistryMutatorShape = { reconcile };

    return { registry, mutator };
  });

export { defaultInstanceIdForDriver };
