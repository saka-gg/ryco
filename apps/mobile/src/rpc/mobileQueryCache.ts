// A bounded, environment-scoped cache of node reads over the shared keyed-query
// layer (defineKeyedQueryByKey), for the phone's node-backed screens. Each
// cache owns one registry; node-owned results live in its atom state — never
// logged — and are dropped when the environment is torn down or the
// retained-key budget is exceeded.
//
// A query that sets `persist` is also kept on the device (savedQueries.ts):
// its last live answer is read back the first time a screen watches it and
// shown at once (`savedAt` set) while the live read runs behind it.
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

import { awaitSavedQueryStore, type SavedQueryCodec } from "./savedQueries";

export interface MobileQueryState<T> {
  readonly data: T | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
  /** When the shown data was saved on this device; null once a live answer replaced it. */
  readonly savedAt: number | null;
}

export interface MobileQueryWriteOptions {
  /**
   * The data is the node's own answer (a status push, a mutation's result):
   * it counts as a fresh read and is saved like one. Otherwise the write is a
   * local overlay (an optimistic change) that the next read confirms or
   * replaces, and it is never saved.
   */
  readonly live?: boolean;
}

export interface MobileQuery<TInput, TData> extends KeyedQueryByKey<
  TInput,
  TData,
  MobileQueryState<TData>
> {
  /**
   * Writes the entry's data directly. Reads already in flight are fenced so an
   * older answer cannot replace the write. `updater` returning null leaves the
   * entry untouched.
   */
  readonly writeData: (
    compositeKey: string | null,
    updater: (current: TData | null) => TData | null,
    options?: MobileQueryWriteOptions,
  ) => void;
}

export interface MobileQueryDefinition<TInput, TData> {
  readonly label: string;
  readonly staleTime: number;
  readonly retainedKeyLimit: number;
  readonly isEnabled: (input: TInput) => boolean;
  /** Must start with the environment id (teardown matches on it). */
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly run: (input: TInput) => Promise<TData>;
  /** Keep the last live answer on the device and show it first (see savedQueries.ts). */
  readonly persist?: SavedQueryCodec<TData>;
  /**
   * False for an entry fed by someone else (a status stream, a screen's own
   * controller) through `writeData(..., { live: true })`: a watch never reads,
   * only an explicit refresh runs `run`. Defaults to true.
   */
  readonly fetchOnWatch?: boolean;
}

/**
 * A saved copy of what a screen reads by its own means (a stream, a controller
 * with write rules of its own): the screen writes each live answer with
 * `writeData(..., { live: true })` and shows the saved copy until one arrives.
 */
export interface MobileSavedMirrorDefinition<TInput, TData> {
  readonly label: string;
  readonly retainedKeyLimit: number;
  readonly isEnabled: (input: TInput) => boolean;
  /** Must start with the environment id (teardown matches on it). */
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly persist: SavedQueryCodec<TData>;
}

const INITIAL_QUERY_STATE: MobileQueryState<never> = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  error: null,
  savedAt: null,
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
  readonly defineSavedMirror: <TInput, TData>(
    definition: MobileSavedMirrorDefinition<TInput, TData>,
  ) => MobileQuery<TInput, TData>;
  /**
   * Marks every entry stale and fences reads in flight; observed entries read
   * again in the background (their previous data stays visible).
   */
  readonly invalidate: () => void;
  /**
   * After a change the reader made: every entry whose key parts (`[label,
   * ...buildKey parts]`) match is marked stale and fenced, and the observed
   * ones read again in the background.
   */
  readonly refreshMatching: (matches: (parts: ReadonlyArray<string>) => boolean) => void;
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
      savedAt: current.savedAt,
    }),
    buildSuccessState: (data) => ({
      data,
      isLoading: false,
      isFetching: false,
      error: null,
      savedAt: null,
    }),
    buildErrorState: (current, error) => ({
      data: current.data,
      isLoading: false,
      isFetching: false,
      error,
      savedAt: current.savedAt,
    }),
    onPublish: (controller, data) => saveLiveAnswer(controller, data),
  });

  /** Persisted query codecs by query label (labels are unique within a cache). */
  const persistedCodecs = new Map<string, SavedQueryCodec<unknown>>();
  /** Controllers whose saved copy was already looked up: once per controller life. */
  const lookedUp = new WeakSet<object>();

  /** The device key of one entry: unique across caches. */
  function savedKey(compositeKey: string): string {
    return `${labelPrefix}${KEY_SEP}${compositeKey}`;
  }

  function saveLiveAnswer(
    controller: {
      readonly compositeKey: string;
      readonly family: string;
      readonly environmentId: EnvironmentId;
    },
    data: unknown,
  ): void {
    const codec = persistedCodecs.get(controller.family);
    if (codec === undefined || data === null || data === undefined) return;
    const key = savedKey(controller.compositeKey);
    void awaitSavedQueryStore().then((store) => {
      store?.save(controller.environmentId, key, codec.version, () => codec.encode(data));
    });
  }

  /**
   * Shows the entry's saved answer when it has nothing yet. The live read was
   * already started by the watch; whichever lands first shows, and a saved
   * answer never replaces data the entry already holds (a live answer, or one
   * written meanwhile). A torn-down or evicted entry is a new controller, so a
   * late answer for the old one is dropped.
   */
  function showSavedAnswer(compositeKey: string, codec: SavedQueryCodec<unknown>): void {
    const controller = registry.controllers.get(compositeKey);
    if (controller === undefined || lookedUp.has(controller)) return;
    lookedUp.add(controller);
    if (controller.hasData || registry.getQueryState(compositeKey).data !== null) return;
    const environmentId = controller.environmentId;
    void awaitSavedQueryStore()
      .then((store) => store?.load(environmentId, savedKey(compositeKey), codec.version) ?? null)
      .then((saved) => {
        if (saved === null || registry.controllers.get(compositeKey) !== controller) return;
        const current = registry.getQueryState(compositeKey);
        if (controller.hasData || current.data !== null) return;
        let data: unknown;
        try {
          data = codec.decode(saved.payload);
        } catch {
          data = null;
        }
        if (data === null || data === undefined) return;
        registry.setQueryState(compositeKey, {
          ...current,
          data,
          isLoading: false,
          savedAt: saved.savedAt,
        });
      })
      .catch((error: unknown) => {
        console.warn(`[${labelPrefix}] could not read a saved answer`, error);
      });
  }

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
        definition.fetchOnWatch !== false &&
        (!controller.hasData || Date.now() - controller.lastFetchedAt >= controller.staleTime),
    ) as MobileQuery<TInput, TData>;

    const tracker = createRetainedKeyTracker({
      limit: definition.retainedKeyLimit,
      onEvict: dropCachedKey,
      environmentPrefix: (environmentId) =>
        `${definition.label}${KEY_SEP}${environmentId}${KEY_SEP}`,
    });
    retainedKeyTrackers.push(tracker);
    const persist = definition.persist as SavedQueryCodec<unknown> | undefined;
    if (persist !== undefined) persistedCodecs.set(definition.label, persist);

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
      if (compositeKey !== null && persist !== undefined) showSavedAnswer(compositeKey, persist);
      return () => {
        release();
        if (compositeKey === null) return;
        const controller = registry.controllers.get(compositeKey);
        if (!controller || controller.subscriberCount > 0) return;
        tracker.release(compositeKey);
      };
    }

    function writeData(
      compositeKey: string | null,
      updater: (current: TData | null) => TData | null,
      options?: MobileQueryWriteOptions,
    ): void {
      if (compositeKey === null) return;
      const current = registry.getQueryState(compositeKey) as MobileQueryState<TData>;
      const next = updater(current.data);
      if (next === null) return;
      const controller = registry.controllers.get(compositeKey);
      if (controller !== undefined) {
        // An older read in flight must not publish over this write.
        registry.markLocalWrite(controller);
        if (options?.live === true) {
          controller.hasData = true;
          controller.lastFetchedAt = Date.now();
        }
      }
      trackedKeys.add(compositeKey);
      registry.setQueryState(compositeKey, {
        ...current,
        data: next,
        isLoading: false,
        ...(options?.live === true ? { error: null, savedAt: null } : {}),
      });
      if (options?.live === true && controller !== undefined) saveLiveAnswer(controller, next);
    }

    return { ...query, watch, writeData };
  }

  function refreshController(controller: Parameters<typeof registry.cancel>[0]): void {
    // A mirror has nothing to read again: its screen writes it.
    if (mirrorFamilies.has(controller.family)) return;
    controller.lastFetchedAt = 0;
    // Fence any response already in flight before asking an observed query
    // for fresh node-owned state. The registry otherwise joins duplicate
    // callers, which would let the refresh wait on the stale request.
    registry.cancel(controller);
    if (controller.subscriberCount > 0) {
      void registry.runController(controller);
    }
  }

  const mirrorFamilies = new Set<string>();

  function defineSavedMirror<TInput, TData>(
    definition: MobileSavedMirrorDefinition<TInput, TData>,
  ): MobileQuery<TInput, TData> {
    mirrorFamilies.add(definition.label);
    return defineQuery<TInput, TData>({
      ...definition,
      staleTime: Number.POSITIVE_INFINITY,
      fetchOnWatch: false,
      run: () => Promise.reject(new Error(`${definition.label} is written by its screen`)),
    });
  }

  return {
    defineQuery,
    defineSavedMirror,
    refreshMatching: (matches) => {
      for (const [compositeKey, controller] of registry.controllers) {
        if (matches(compositeKey.split(KEY_SEP))) refreshController(controller);
      }
    },
    invalidate: () => {
      for (const controller of registry.controllers.values()) refreshController(controller);
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
