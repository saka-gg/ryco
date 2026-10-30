// A bounded, environment-scoped cache of node reads over the shared keyed-query
// layer (defineKeyedQueryByKey), for the phone's read-only surfaces: the
// workspace file browser and the pull request screens. Each cache owns one
// registry; node-owned results live only in its atom state — never persisted,
// never logged — and are dropped when the environment is torn down or the
// retained-key budget is exceeded.
import type { EnvironmentId } from "@ryco/contracts";
import {
  clearKeyedQueriesForEnvironment,
  createKeyedQueryRegistry,
  createRetainedKeyTracker,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
  type RetainedKeyTracker,
} from "@ryco/client-runtime/rpc";

export interface MobileQueryState<T> {
  readonly data: T | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

export type MobileQuery<TInput, TData> = KeyedQueryByKey<TInput, TData, MobileQueryState<TData>>;

export interface MobileQueryDefinition<TInput, TData> {
  readonly label: string;
  readonly staleTime: number;
  readonly retainedKeyLimit: number;
  readonly isEnabled: (input: TInput) => boolean;
  /** Must start with the environment id (teardown matches on it). */
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly run: (input: TInput) => Promise<TData>;
}

const INITIAL_QUERY_STATE: MobileQueryState<never> = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  error: null,
});

const FETCH_RETRY_COUNT = 1;

export function runWithRetry<T>(run: () => Promise<T>, retries = FETCH_RETRY_COUNT): Promise<T> {
  return run().catch((error) => {
    if (retries <= 0) {
      throw error;
    }
    return runWithRetry(run, retries - 1);
  });
}

export interface MobileQueryCache {
  readonly defineQuery: <TInput, TData>(
    definition: MobileQueryDefinition<TInput, TData>,
  ) => MobileQuery<TInput, TData>;
  /**
   * Marks every entry stale and fences reads in flight; observed entries read
   * again in the background (their previous data stays visible).
   */
  readonly invalidate: () => void;
  /** Environment teardown: forget everything the cache holds for one node. */
  readonly clearEnvironment: (environmentId: EnvironmentId) => void;
  /** Cache-only eviction of one node's unobserved entries; an entry on screen stays. */
  readonly clearUnobserved: (environmentId: EnvironmentId) => void;
  /** One node's unobserved entries as `[label, data]`, for storage accounting. */
  readonly unobservedEntries: (
    environmentId: EnvironmentId,
  ) => ReadonlyArray<readonly [string, unknown]>;
  readonly resetForTests: () => void;
}

export function createMobileQueryCache(labelPrefix: string): MobileQueryCache {
  const registry = createKeyedQueryRegistry<MobileQueryState<unknown>>({
    labelPrefix,
    initialState: INITIAL_QUERY_STATE,
    // Data stays visible across a background refetch; only a first load reports
    // isLoading, and an error never blanks a result the user is still reading.
    buildFetchingState: (current) => ({
      data: current.data,
      isLoading: current.data === null,
      isFetching: true,
      error: null,
    }),
    buildSuccessState: (data) => ({
      data,
      isLoading: false,
      isFetching: false,
      error: null,
    }),
    buildErrorState: (current, error) => ({
      data: current.data,
      isLoading: false,
      isFetching: false,
      error,
    }),
  });

  /**
   * Every composite key this cache has ever watched.
   *
   * The registry's own `knownStateKeys` cannot be used for teardown: it is filled
   * from the `Atom.family` factory, which runs once per key, so a key the registry
   * removes from that set on a clear/reset is never re-added when the same key is
   * watched again — its state atom would then survive the next teardown holding
   * node content. Only `watch` mints controllers, and only controllers publish, so
   * watching is the complete record of keys that can hold data.
   */
  const trackedKeys = new Set<string>();
  const retainedKeyTrackers: RetainedKeyTracker[] = [];

  /**
   * Forget one cache key completely: the controller is dropped, its in-flight
   * response is fenced by the token bump (runController discards a result whose
   * token moved), and the state atom falls back to the initial state so a later
   * read cannot observe evicted node content.
   */
  function dropCachedKey(compositeKey: string): void {
    const controller = registry.controllers.get(compositeKey);
    if (controller) {
      registry.clearPollTimer(controller);
      controller.fetchToken += 1;
      registry.controllers.delete(compositeKey);
    }
    registry.setQueryState(compositeKey, registry.initialState);
    registry.knownStateKeys.delete(compositeKey);
    trackedKeys.delete(compositeKey);
  }

  function isObserved(compositeKey: string): boolean {
    return (registry.controllers.get(compositeKey)?.subscriberCount ?? 0) > 0;
  }

  function keyEnvironment(compositeKey: string): string | undefined {
    return compositeKey.split(KEY_SEP)[1];
  }

  function defineQuery<TInput, TData>(
    definition: MobileQueryDefinition<TInput, TData>,
  ): MobileQuery<TInput, TData> {
    const query = defineKeyedQueryByKey(
      registry,
      {
        ...definition,
        createControllerFields: () => ({}),
      },
      (controller) =>
        !controller.hasData || Date.now() - controller.lastFetchedAt >= controller.staleTime,
    ) as MobileQuery<TInput, TData>;

    const tracker = createRetainedKeyTracker({
      limit: definition.retainedKeyLimit,
      onEvict: dropCachedKey,
      environmentPrefix: (environmentId) =>
        `${definition.label}${KEY_SEP}${environmentId}${KEY_SEP}`,
    });
    retainedKeyTrackers.push(tracker);

    // The shared watch has no release hook, so the eviction budget is applied
    // here: the wrapper re-retains a key on watch and hands it to the tracker once
    // the last observer goes away.
    function watch(input: TInput): () => void {
      const compositeKey = query.keyOf(input);
      if (compositeKey !== null) {
        trackedKeys.add(compositeKey);
        tracker.retain(compositeKey);
      }
      const release = query.watch(input);
      return () => {
        release();
        if (compositeKey === null) return;
        const controller = registry.controllers.get(compositeKey);
        if (!controller || controller.subscriberCount > 0) return;
        tracker.release(compositeKey);
      };
    }

    return { ...query, watch };
  }

  return {
    defineQuery,
    invalidate: () => {
      for (const controller of registry.controllers.values()) {
        controller.lastFetchedAt = 0;
        // Fence any response already in flight before asking an observed query
        // for fresh node-owned state. The registry otherwise joins duplicate
        // callers, which would let the invalidation wait on the stale request.
        registry.cancel(controller);
        if (controller.subscriberCount > 0) {
          void registry.runController(controller);
        }
      }
    },
    clearEnvironment: (environmentId) => {
      // The registry-global helper runs first — this is the single mobile teardown
      // site, so a keyed-query cache added later is covered without another
      // registration. It is not sufficient on its own: its state sweep matches
      // keys that START with the environment id while a `defineKeyedQueryByKey`
      // composite key is label-first, and it can only see the keys the registry
      // still tracks. The second pass is the authoritative one for this cache.
      clearKeyedQueriesForEnvironment(environmentId);
      // `dropCachedKey` only removes the key being visited, which Set iteration
      // tolerates.
      for (const compositeKey of trackedKeys) {
        if (keyEnvironment(compositeKey) !== environmentId) continue;
        dropCachedKey(compositeKey);
      }
      for (const tracker of retainedKeyTrackers) tracker.forgetEnvironment(environmentId);
    },
    clearUnobserved: (environmentId) => {
      for (const compositeKey of trackedKeys) {
        if (keyEnvironment(compositeKey) === environmentId && !isObserved(compositeKey)) {
          dropCachedKey(compositeKey);
        }
      }
      for (const tracker of retainedKeyTrackers) tracker.forgetEnvironment(environmentId);
    },
    unobservedEntries: (environmentId) => {
      const entries: Array<readonly [string, unknown]> = [];
      for (const compositeKey of trackedKeys) {
        const [label, environment] = compositeKey.split(KEY_SEP);
        if (environment !== environmentId || isObserved(compositeKey)) continue;
        entries.push([label ?? "", registry.getQueryState(compositeKey).data]);
      }
      return entries;
    },
    resetForTests: () => {
      registry.resetForTests();
      for (const compositeKey of trackedKeys) dropCachedKey(compositeKey);
      for (const tracker of retainedKeyTrackers) tracker.clear();
    },
  };
}
