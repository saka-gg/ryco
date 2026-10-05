import type { EnvironmentId } from "@ryco/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry.ts";
import type { AppLifecycleService } from "../platform/index.ts";

export const KEY_SEP = "\u0000";
export const NOOP: () => void = () => undefined;

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface KeyedQueryLifecycleRefreshContext<TData> {
  readonly data: TData | null;
  readonly hasData: boolean;
  readonly lastFetchedAt: number;
  readonly staleTime: number;
}

export interface KeyedQueryWatchOptions<TData> {
  readonly resolveIntervalMs?: (data: TData | null) => number | false;
  readonly shouldRefreshOnLifecycle?: (
    context: KeyedQueryLifecycleRefreshContext<TData>,
  ) => boolean;
}

interface KeyedQueryPollSubscriber {
  readonly resolveIntervalMs?: (data: unknown) => number | false;
  readonly shouldRefreshOnLifecycle?: (
    context: KeyedQueryLifecycleRefreshContext<unknown>,
  ) => boolean;
}

export interface KeyedQueryControllerBase {
  readonly compositeKey: string;
  readonly environmentId: EnvironmentId;
  readonly family: string;
  readonly staleTime: number;
  readonly gcTime: number;
  readonly run: () => Promise<unknown>;
  subscriberCount: number;
  lastFetchedAt: number;
  lastAccessedAt: number;
  fetchToken: number;
  hasData: boolean;
  inFlightPromise: Promise<void> | null;
  gcTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollSubscribers: Map<number, KeyedQueryPollSubscriber>;
  nextPollSubscriberId: number;
  /**
   * Bumped by every local write (`updateData`). A read that started before the
   * latest local write carries older server state than the cache now holds, so
   * it must neither publish over that write nor absorb later refresh requests.
   * Optional so hand-built controllers keep compiling; absent means 0.
   */
  localWriteEpoch?: number;
  /** `localWriteEpoch` observed when the current `inFlightPromise` started. */
  inFlightLocalWriteEpoch?: number;
  /** `Date.now()` of the latest local write; absent when there was none. */
  lastLocalWriteAt?: number;
}

export interface KeyedQueryAdmission {
  /** Null pauses reads; a changed key fences in-flight work. */
  readonly key: string | null;
  /** Null forbids retained data; a changed scope clears the old authority's data. */
  readonly scope: string | null;
}

export interface KeyedQueryRegistryConfig<TState> {
  readonly labelPrefix: string;
  readonly initialState: TState;
  readonly buildFetchingState: (current: TState) => TState;
  readonly buildSuccessState: (data: unknown) => TState;
  readonly buildErrorState: (current: TState, error: Error) => TState;
  readonly isErrorState?: (state: TState) => boolean;
  readonly selectPollData?: (state: TState) => unknown;
  readonly gcTime?: number;
  readonly maxEntries?: number;
  readonly lifecycle?: AppLifecycleService;
  /** Platform-owned read authority; a changed key fences every older result. */
  readonly admission?: {
    readonly readState: (
      controller: KeyedQueryControllerBase & Record<string, unknown>,
    ) => KeyedQueryAdmission;
    readonly subscribe: (listener: () => void) => () => void;
    readonly buildPausedState: (
      current: TState,
      controller: KeyedQueryControllerBase & Record<string, unknown>,
      retainData: boolean,
    ) => TState;
  };
  readonly pollJitterRatio?: number;
  readonly random?: () => number;
  readonly adjustPollDelay?: (
    baseDelayMs: number,
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ) => number;
  readonly onRunStart?: (controller: KeyedQueryControllerBase & Record<string, unknown>) => void;
  readonly onRunEnd?: (
    controller: KeyedQueryControllerBase & Record<string, unknown>,
    outcome: "success" | "error",
  ) => void;
  /**
   * Called after a read's result is published to the controller's state, and
   * only then: never for reads fenced by a cancel or superseded by a local
   * write. Lets a registry share fresh data with related entries.
   */
  readonly onPublish?: (
    controller: KeyedQueryControllerBase & Record<string, unknown>,
    data: unknown,
  ) => void;
  readonly shouldFetchOnWatch?: (
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ) => boolean;
}

export interface KeyedQueryRegistry<TState> {
  readonly KEY_SEP: typeof KEY_SEP;
  readonly knownStateKeys: Set<string>;
  readonly controllers: Map<string, KeyedQueryControllerBase & Record<string, unknown>>;
  readonly queryStateAtom: (compositeKey: string) => Atom.Atom<TState>;
  readonly EMPTY_QUERY_ATOM: Atom.Atom<TState>;
  readonly initialState: TState;
  readonly defaultGcTime: number;
  registerController(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  setQueryState(compositeKey: string, next: TState): void;
  /**
   * Record a local write to the controller's data. Reads already in flight are
   * superseded: they finish their bookkeeping but never publish, and the next
   * run starts a fresh read instead of joining them.
   */
  markLocalWrite(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  getQueryState(compositeKey: string): TState;
  runController(controller: KeyedQueryControllerBase & Record<string, unknown>): Promise<void>;
  /**
   * The cadence the controller's subscribers ask for given its current data
   * (the fastest one), before failure backoff and jitter; null when none polls.
   */
  pollInterval(controller: KeyedQueryControllerBase & Record<string, unknown>): number | null;
  schedulePoll(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  clearPollTimer(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  touch(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  cancel(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  scheduleGc(controller: KeyedQueryControllerBase & Record<string, unknown>): void;
  evict(compositeKey: string): boolean;
  controllerKeys(filters?: {
    readonly environmentId?: EnvironmentId;
    readonly family?: string;
  }): ReadonlySet<string>;
  fenceActiveEnvironment(environmentId: EnvironmentId): void;
  refreshActiveEnvironment(environmentId: EnvironmentId): Promise<void>;
  clearEnvironment(environmentId: EnvironmentId): void;
  resetForTests(): void;
  dispose(): void;
}

interface KeyedQueryEnvironmentCleanup {
  clearEnvironment(environmentId: EnvironmentId): void;
  fenceActiveEnvironment(environmentId: EnvironmentId): void;
  refreshActiveEnvironment(environmentId: EnvironmentId): Promise<void>;
}

const keyedQueryEnvironmentCleanups = new Set<KeyedQueryEnvironmentCleanup>();

export function clearKeyedQueriesForEnvironment(environmentId: EnvironmentId): void {
  for (const cleanup of keyedQueryEnvironmentCleanups) cleanup.clearEnvironment(environmentId);
}

export function fenceActiveKeyedQueriesForEnvironment(environmentId: EnvironmentId): void {
  for (const cleanup of keyedQueryEnvironmentCleanups) {
    cleanup.fenceActiveEnvironment(environmentId);
  }
}

export async function refreshActiveKeyedQueriesForEnvironment(
  environmentId: EnvironmentId,
): Promise<void> {
  await Promise.all(
    [...keyedQueryEnvironmentCleanups].map((cleanup) =>
      cleanup.refreshActiveEnvironment(environmentId),
    ),
  );
}

export function createKeyedQueryRegistry<TState>(
  config: KeyedQueryRegistryConfig<TState>,
): KeyedQueryRegistry<TState> {
  const defaultGcTime = Math.max(0, config.gcTime ?? 5 * 60_000);
  const maxEntries = Math.max(1, Math.floor(config.maxEntries ?? 256));
  const knownStateKeys = new Set<string>();
  const controllers = new Map<string, KeyedQueryControllerBase & Record<string, unknown>>();
  const controllerKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
  const controllerKeysByFamily = new Map<string, Set<string>>();
  const pollJitterRatio = Math.max(0, Math.min(0.5, config.pollJitterRatio ?? 0));
  const random = config.random ?? Math.random;
  let disposed = false;
  const admissionStates = new WeakMap<KeyedQueryControllerBase, KeyedQueryAdmission>();
  const pendingAdmissionRefresh = new WeakSet<KeyedQueryControllerBase>();

  const queryStateAtom = Atom.family((compositeKey: string) => {
    knownStateKeys.add(compositeKey);
    return Atom.make<TState>(config.initialState).pipe(
      Atom.setIdleTTL(defaultGcTime),
      Atom.withLabel(`${config.labelPrefix}:${compositeKey}`),
    );
  });

  const EMPTY_QUERY_ATOM = Atom.make<TState>(config.initialState).pipe(
    Atom.keepAlive,
    Atom.withLabel(`${config.labelPrefix}:null`),
  );

  function setQueryState(compositeKey: string, next: TState): void {
    // `Atom.family` caches atoms, so its factory (which records the key) only
    // runs once per key. Re-record on every write so a key written again after
    // an evict/reset/clear (e.g. by `updateData` without a watcher) is still
    // reset by the next `clearEnvironment` / `resetForTests`.
    knownStateKeys.add(compositeKey);
    appAtomRegistry.set(queryStateAtom(compositeKey), next);
  }

  function getQueryState(compositeKey: string): TState {
    return appAtomRegistry.get(queryStateAtom(compositeKey));
  }

  function clearControllerGcTimer(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): void {
    if (controller.gcTimer !== null) {
      clearTimeout(controller.gcTimer);
      controller.gcTimer = null;
    }
  }

  function removeIndexValue<K>(index: Map<K, Set<string>>, key: K, compositeKey: string): void {
    const keys = index.get(key);
    if (!keys) return;
    keys.delete(compositeKey);
    if (keys.size === 0) index.delete(key);
  }

  function evict(compositeKey: string): boolean {
    const controller = controllers.get(compositeKey);
    if (!controller || controller.subscriberCount > 0 || controller.inFlightPromise !== null) {
      return false;
    }
    clearControllerPollTimer(controller);
    clearControllerGcTimer(controller);
    controller.fetchToken += 1;
    controllers.delete(compositeKey);
    removeIndexValue(controllerKeysByEnvironment, controller.environmentId, compositeKey);
    removeIndexValue(controllerKeysByFamily, controller.family, compositeKey);
    if (knownStateKeys.delete(compositeKey)) {
      appAtomRegistry.set(queryStateAtom(compositeKey), config.initialState);
    }
    return true;
  }

  function evictToCapacity(): void {
    if (controllers.size <= maxEntries) return;
    const candidates = [...controllers.values()]
      .filter(
        (controller) => controller.subscriberCount === 0 && controller.inFlightPromise === null,
      )
      .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    for (const controller of candidates) {
      if (controllers.size <= maxEntries) break;
      evict(controller.compositeKey);
    }
  }

  function scheduleControllerGc(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): void {
    clearControllerGcTimer(controller);
    if (controller.subscriberCount > 0 || controller.inFlightPromise !== null) return;
    if (controller.gcTime === 0) {
      evict(controller.compositeKey);
      return;
    }
    controller.gcTimer = setTimeout(() => {
      controller.gcTimer = null;
      evict(controller.compositeKey);
    }, controller.gcTime);
  }

  function touchController(controller: KeyedQueryControllerBase & Record<string, unknown>): void {
    controller.lastAccessedAt = Date.now();
    clearControllerGcTimer(controller);
  }

  function registerController(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): void {
    controllers.set(controller.compositeKey, controller);
    if (config.admission) admissionStates.set(controller, config.admission.readState(controller));
    const environmentKeys = controllerKeysByEnvironment.get(controller.environmentId) ?? new Set();
    environmentKeys.add(controller.compositeKey);
    controllerKeysByEnvironment.set(controller.environmentId, environmentKeys);
    const familyKeys = controllerKeysByFamily.get(controller.family) ?? new Set();
    familyKeys.add(controller.compositeKey);
    controllerKeysByFamily.set(controller.family, familyKeys);
    evictToCapacity();
  }

  function controllerKeys(filters?: {
    readonly environmentId?: EnvironmentId;
    readonly family?: string;
  }): ReadonlySet<string> {
    const byEnvironment = filters?.environmentId
      ? controllerKeysByEnvironment.get(filters.environmentId)
      : undefined;
    const byFamily = filters?.family ? controllerKeysByFamily.get(filters.family) : undefined;
    if (filters?.environmentId && !byEnvironment) return new Set();
    if (filters?.family && !byFamily) return new Set();
    if (byEnvironment && byFamily) {
      const smaller = byEnvironment.size <= byFamily.size ? byEnvironment : byFamily;
      const larger = smaller === byEnvironment ? byFamily : byEnvironment;
      return new Set([...smaller].filter((key) => larger.has(key)));
    }
    return new Set(byEnvironment ?? byFamily ?? controllers.keys());
  }

  function markLocalWrite(controller: KeyedQueryControllerBase & Record<string, unknown>): void {
    controller.localWriteEpoch = (controller.localWriteEpoch ?? 0) + 1;
    controller.lastLocalWriteAt = Date.now();
  }

  async function runController(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): Promise<void> {
    const admissionState = synchronizeAdmission(controller);
    if (admissionState?.key === null) return;
    pendingAdmissionRefresh.delete(controller);
    const localWriteEpoch = controller.localWriteEpoch ?? 0;
    // Join an in-flight read only when no local write happened since it began;
    // otherwise its result predates that write and a fresh read is needed. The
    // token bump below fences the superseded read.
    if (
      controller.inFlightPromise &&
      (controller.inFlightLocalWriteEpoch ?? 0) === localWriteEpoch
    ) {
      return controller.inFlightPromise;
    }
    touchController(controller);
    const token = ++controller.fetchToken;
    const isFenced = () =>
      token !== controller.fetchToken ||
      controllers.get(controller.compositeKey) !== controller ||
      (config.admission !== undefined &&
        (() => {
          const current = config.admission.readState(controller);
          return current.key !== admissionState?.key || current.scope !== admissionState?.scope;
        })());
    const isSupersededByLocalWrite = () => (controller.localWriteEpoch ?? 0) !== localWriteEpoch;
    const promise = (async () => {
      config.onRunStart?.(controller);
      const current = getQueryState(controller.compositeKey);
      setQueryState(controller.compositeKey, config.buildFetchingState(current));

      let published: { readonly data: unknown } | null = null;
      try {
        const data = await controller.run();
        if (isFenced()) return;
        config.onRunEnd?.(controller, "success");
        // The read is older than a local write: keep the write, and leave
        // `lastFetchedAt` untouched so the entry still reads as stale.
        if (isSupersededByLocalWrite()) return;
        controller.hasData = true;
        controller.lastFetchedAt = Date.now();
        setQueryState(controller.compositeKey, config.buildSuccessState(data));
        published = { data };
      } catch (error) {
        if (isFenced()) return;
        config.onRunEnd?.(controller, "error");
        if (isSupersededByLocalWrite()) return;
        setQueryState(
          controller.compositeKey,
          config.buildErrorState(getQueryState(controller.compositeKey), toError(error)),
        );
      }
      // Outside the try: a throwing hook must not turn a published read into an error.
      if (published !== null) config.onPublish?.(controller, published.data);
    })();
    controller.inFlightPromise = promise;
    controller.inFlightLocalWriteEpoch = localWriteEpoch;
    try {
      await promise;
    } finally {
      const isCurrentRun = controller.inFlightPromise === promise;
      if (isCurrentRun) controller.inFlightPromise = null;
      if (isCurrentRun && controllers.get(controller.compositeKey) === controller) {
        scheduleControllerPoll(controller);
        scheduleControllerGc(controller);
        evictToCapacity();
      }
    }
  }

  function cancelController(controller: KeyedQueryControllerBase & Record<string, unknown>): void {
    clearControllerPollTimer(controller);
    controller.fetchToken += 1;
    controller.inFlightPromise = null;
  }

  function clearControllerPollTimer(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): void {
    const timer = controller.pollTimer as ReturnType<typeof setTimeout> | null | undefined;
    if (timer !== null && timer !== undefined) {
      clearTimeout(timer);
      controller.pollTimer = null;
    }
  }

  function resolveControllerPollInterval(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): number | null {
    const data = pollData(controller);
    let interval: number | null = null;
    for (const subscriber of controller.pollSubscribers.values()) {
      const candidate = subscriber.resolveIntervalMs?.(data);
      if (candidate === undefined || candidate === false || candidate <= 0) continue;
      interval = interval === null ? candidate : Math.min(interval, candidate);
    }
    return interval;
  }

  function scheduleControllerPoll(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): void {
    clearControllerPollTimer(controller);
    if (
      disposed ||
      controller.subscriberCount <= 0 ||
      config.admission?.readState(controller).key === null ||
      (config.lifecycle && (!config.lifecycle.isForeground() || !config.lifecycle.isOnline()))
    ) {
      return;
    }
    const interval = resolveControllerPollInterval(controller);
    if (interval === null) {
      return;
    }
    const adjustedInterval = Math.max(
      1,
      config.adjustPollDelay?.(interval, controller) ?? interval,
    );
    const jitter = adjustedInterval * pollJitterRatio * (random() * 2 - 1);
    const delay = Math.max(1, Math.round(adjustedInterval + jitter));
    controller.pollTimer = setTimeout(() => {
      controller.pollTimer = null;
      if (config.lifecycle && (!config.lifecycle.isForeground() || !config.lifecycle.isOnline())) {
        return;
      }
      void runController(controller);
    }, delay);
  }

  function pollData(controller: KeyedQueryControllerBase & Record<string, unknown>): unknown {
    const state = getQueryState(controller.compositeKey);
    return config.selectPollData ? config.selectPollData(state) : state;
  }

  function shouldRefreshControllerOnLifecycle(
    controller: KeyedQueryControllerBase & Record<string, unknown>,
  ): boolean {
    const context: KeyedQueryLifecycleRefreshContext<unknown> = {
      data: pollData(controller),
      hasData: controller.hasData,
      lastFetchedAt: controller.lastFetchedAt,
      staleTime: controller.staleTime,
    };
    for (const subscriber of controller.pollSubscribers.values()) {
      if (subscriber.shouldRefreshOnLifecycle?.(context)) return true;
    }
    return false;
  }

  function handleLifecycleEvent(
    event: Parameters<AppLifecycleService["subscribe"]>[0] extends (event: infer TEvent) => void
      ? TEvent
      : never,
  ): void {
    if (event === "background" || event === "offline") {
      for (const controller of controllers.values()) clearControllerPollTimer(controller);
      return;
    }
    if (
      disposed ||
      !config.lifecycle?.isForeground() ||
      !config.lifecycle.isOnline() ||
      (event !== "foreground" && event !== "resume" && event !== "online")
    ) {
      return;
    }
    for (const controller of controllers.values()) {
      if (controller.subscriberCount <= 0) continue;
      clearControllerPollTimer(controller);
      if (
        pendingAdmissionRefresh.has(controller) ||
        shouldRefreshControllerOnLifecycle(controller)
      ) {
        void runController(controller);
      } else {
        scheduleControllerPoll(controller);
      }
    }
  }

  function resetForTests(): void {
    for (const controller of controllers.values()) {
      clearControllerPollTimer(controller);
      clearControllerGcTimer(controller);
      controller.fetchToken += 1;
    }
    controllers.clear();
    controllerKeysByEnvironment.clear();
    controllerKeysByFamily.clear();
    for (const compositeKey of knownStateKeys) {
      appAtomRegistry.set(queryStateAtom(compositeKey), config.initialState);
    }
    knownStateKeys.clear();
  }

  function synchronizeAdmission(controller: KeyedQueryControllerBase & Record<string, unknown>) {
    const admission = config.admission;
    if (!admission) return undefined;
    const next = admission.readState(controller);
    const previous = admissionStates.get(controller);
    if (previous?.key === next.key && previous.scope === next.scope)
      return { ...next, changed: false };
    admissionStates.set(controller, next);
    cancelController(controller);
    controller.lastFetchedAt = 0;
    controller.hasData = false;
    pendingAdmissionRefresh.delete(controller);
    setQueryState(
      controller.compositeKey,
      admission.buildPausedState(
        getQueryState(controller.compositeKey),
        controller,
        next.scope !== null && previous?.scope === next.scope,
      ),
    );
    scheduleControllerGc(controller);
    return { ...next, changed: true };
  }

  const unsubscribeAdmission =
    config.admission?.subscribe(() => {
      if (disposed) return;
      for (const controller of controllers.values()) {
        const admission = synchronizeAdmission(controller);
        if (!admission?.changed || admission.key === null || controller.subscriberCount <= 0)
          continue;
        if (
          config.lifecycle &&
          (!config.lifecycle.isForeground() || !config.lifecycle.isOnline())
        ) {
          pendingAdmissionRefresh.add(controller);
        } else void runController(controller);
      }
    }) ?? NOOP;

  const unsubscribeLifecycle = config.lifecycle?.subscribe(handleLifecycleEvent) ?? NOOP;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribeLifecycle();
    unsubscribeAdmission();
    resetForTests();
    keyedQueryEnvironmentCleanups.delete(registry);
  }

  function clearEnvironment(environmentId: EnvironmentId): void {
    const removedKeys = new Set<string>();
    for (const compositeKey of controllerKeys({ environmentId })) {
      const controller = controllers.get(compositeKey);
      if (!controller) continue;
      clearControllerPollTimer(controller);
      clearControllerGcTimer(controller);
      controller.fetchToken += 1;
      controllers.delete(compositeKey);
      removeIndexValue(controllerKeysByFamily, controller.family, compositeKey);
      removedKeys.add(compositeKey);
    }
    controllerKeysByEnvironment.delete(environmentId);
    for (const compositeKey of knownStateKeys) {
      if (
        !removedKeys.has(compositeKey) &&
        !compositeKey.startsWith(`${environmentId}${KEY_SEP}`)
      ) {
        continue;
      }
      appAtomRegistry.set(queryStateAtom(compositeKey), config.initialState);
      knownStateKeys.delete(compositeKey);
    }
  }

  function fenceActiveEnvironment(environmentId: EnvironmentId): void {
    for (const compositeKey of controllerKeys({ environmentId })) {
      const controller = controllers.get(compositeKey);
      if (!controller || controller.subscriberCount <= 0) continue;
      cancelController(controller);
    }
  }

  async function refreshActiveEnvironment(environmentId: EnvironmentId): Promise<void> {
    const runs: Array<Promise<void>> = [];
    const now = Date.now();
    for (const compositeKey of controllerKeys({ environmentId })) {
      const controller = controllers.get(compositeKey);
      if (!controller || controller.subscriberCount <= 0) continue;
      const state = getQueryState(compositeKey);
      const isStale =
        !controller.hasData ||
        config.isErrorState?.(state) === true ||
        (controller.staleTime !== Infinity &&
          now - controller.lastFetchedAt >= controller.staleTime);
      if (!isStale) continue;
      runs.push(runController(controller));
    }
    await Promise.all(runs);
  }

  const registry: KeyedQueryRegistry<TState> = {
    KEY_SEP,
    knownStateKeys,
    controllers,
    queryStateAtom,
    EMPTY_QUERY_ATOM,
    initialState: config.initialState,
    defaultGcTime,
    registerController,
    setQueryState,
    markLocalWrite,
    getQueryState,
    runController,
    pollInterval: resolveControllerPollInterval,
    schedulePoll: scheduleControllerPoll,
    clearPollTimer: clearControllerPollTimer,
    touch: touchController,
    cancel: cancelController,
    scheduleGc: scheduleControllerGc,
    evict,
    controllerKeys,
    fenceActiveEnvironment,
    refreshActiveEnvironment,
    clearEnvironment,
    resetForTests,
    dispose,
  };
  keyedQueryEnvironmentCleanups.add(registry);
  return registry;
}

interface KeyedQueryDefinition<TInput, TData, TControllerFields extends Record<string, unknown>> {
  readonly label: string;
  readonly staleTime: number;
  readonly gcTime?: number;
  readonly isEnabled: (input: TInput) => boolean;
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly createControllerFields: (input: TInput) => TControllerFields;
  readonly run: (input: TInput) => Promise<TData>;
}

export interface KeyedQueryByKey<TInput, _TData, TState> {
  readonly keyOf: (input: TInput) => string | null;
  readonly watch: (input: TInput) => () => void;
  readonly refresh: (compositeKey: string | null) => void;
  readonly refreshAsync: (compositeKey: string | null) => Promise<TState>;
  readonly getAtom: (compositeKey: string | null) => Atom.Atom<TState>;
  readonly getSnapshot: (compositeKey: string | null) => TState;
}

export function defineKeyedQueryByKey<
  TInput,
  TData,
  TState,
  TControllerFields extends Record<string, unknown>,
>(
  registry: KeyedQueryRegistry<TState>,
  definition: KeyedQueryDefinition<TInput, TData, TControllerFields>,
  shouldFetchOnWatch: (controller: KeyedQueryControllerBase & Record<string, unknown>) => boolean,
): KeyedQueryByKey<TInput, TData, TState> {
  function keyOf(input: TInput): string | null {
    if (!definition.isEnabled(input)) {
      return null;
    }
    return `${definition.label}${KEY_SEP}${definition.buildKey(input)}`;
  }

  function getAtom(compositeKey: string | null): Atom.Atom<TState> {
    return (
      compositeKey === null ? registry.EMPTY_QUERY_ATOM : registry.queryStateAtom(compositeKey)
    ) as Atom.Atom<TState>;
  }

  function getSnapshot(compositeKey: string | null): TState {
    if (compositeKey === null) {
      return registry.initialState;
    }
    return registry.getQueryState(compositeKey);
  }

  function watch(input: TInput): () => void {
    const compositeKey = keyOf(input);
    if (compositeKey === null) {
      return NOOP;
    }

    let controller = registry.controllers.get(compositeKey);
    if (!controller) {
      controller = {
        compositeKey,
        environmentId: definition.resolveEnvironmentId(input),
        family: definition.label,
        staleTime: definition.staleTime,
        gcTime: Math.max(0, definition.gcTime ?? registry.defaultGcTime),
        run: () => definition.run(input),
        subscriberCount: 0,
        lastFetchedAt: 0,
        lastAccessedAt: Date.now(),
        fetchToken: 0,
        hasData: false,
        inFlightPromise: null,
        gcTimer: null,
        pollTimer: null,
        pollSubscribers: new Map(),
        nextPollSubscriberId: 0,
        ...definition.createControllerFields(input),
      };
      registry.registerController(controller);
    }

    registry.touch(controller);
    controller.subscriberCount += 1;
    if (shouldFetchOnWatch(controller)) {
      void registry.runController(controller);
    }

    return () => {
      const current = registry.controllers.get(compositeKey);
      if (!current) {
        return;
      }
      current.subscriberCount = Math.max(0, current.subscriberCount - 1);
      registry.scheduleGc(current);
    };
  }

  function refresh(compositeKey: string | null): void {
    if (compositeKey === null) {
      return;
    }
    const controller = registry.controllers.get(compositeKey);
    if (!controller) {
      return;
    }
    controller.lastFetchedAt = 0;
    void registry.runController(controller);
  }

  async function refreshAsync(compositeKey: string | null): Promise<TState> {
    if (compositeKey === null) {
      return registry.initialState;
    }
    const controller = registry.controllers.get(compositeKey);
    if (!controller) {
      return registry.getQueryState(compositeKey);
    }
    controller.lastFetchedAt = 0;
    await registry.runController(controller);
    return registry.getQueryState(compositeKey);
  }

  return { keyOf, watch, refresh, refreshAsync, getAtom, getSnapshot };
}

export interface KeyedQueryByInput<TInput, TData, TState> {
  readonly targetKey: (input: TInput) => string | null;
  readonly atomFor: (input: TInput) => Atom.Atom<TState>;
  readonly snapshotFor: (input: TInput) => TState;
  readonly watch: (
    input: TInput,
    options?: ((data: TData | null) => number | false) | KeyedQueryWatchOptions<TData>,
  ) => () => void;
  readonly refresh: (input: TInput) => void;
  readonly refreshAsync: (input: TInput) => Promise<TState>;
  readonly updateData: (input: TInput, updater: (current: TData | null) => TData | null) => void;
}

export function defineKeyedQueryByInput<
  TInput,
  TData,
  TState,
  TControllerFields extends Record<string, unknown>,
>(
  registry: KeyedQueryRegistry<TState>,
  definition: KeyedQueryDefinition<TInput, TData, TControllerFields>,
  shouldFetchOnWatch: (controller: KeyedQueryControllerBase & Record<string, unknown>) => boolean,
): KeyedQueryByInput<TInput, TData, TState> {
  function compositeKeyFor(input: TInput): string | null {
    if (!definition.isEnabled(input)) {
      return null;
    }
    return `${definition.label}${KEY_SEP}${definition.buildKey(input)}`;
  }

  function atomFor(input: TInput): Atom.Atom<TState> {
    const compositeKey = compositeKeyFor(input);
    return (
      compositeKey === null ? registry.EMPTY_QUERY_ATOM : registry.queryStateAtom(compositeKey)
    ) as Atom.Atom<TState>;
  }

  function snapshotFor(input: TInput): TState {
    const compositeKey = compositeKeyFor(input);
    if (compositeKey === null) {
      return registry.initialState;
    }
    return registry.getQueryState(compositeKey);
  }

  function watch(
    input: TInput,
    options?: ((data: TData | null) => number | false) | KeyedQueryWatchOptions<TData>,
  ): () => void {
    const compositeKey = compositeKeyFor(input);
    if (compositeKey === null) {
      return NOOP;
    }

    let controller = registry.controllers.get(compositeKey);
    if (!controller) {
      controller = {
        compositeKey,
        environmentId: definition.resolveEnvironmentId(input),
        family: definition.label,
        staleTime: definition.staleTime,
        gcTime: Math.max(0, definition.gcTime ?? registry.defaultGcTime),
        run: () => definition.run(input),
        subscriberCount: 0,
        lastFetchedAt: 0,
        lastAccessedAt: Date.now(),
        fetchToken: 0,
        hasData: false,
        inFlightPromise: null,
        gcTimer: null,
        pollTimer: null,
        pollSubscribers: new Map(),
        nextPollSubscriberId: 0,
        ...definition.createControllerFields(input),
      };
      registry.registerController(controller);
    }

    registry.touch(controller);
    const subscriptionId = controller.nextPollSubscriberId++;
    const normalizedOptions =
      typeof options === "function" ? { resolveIntervalMs: options } : (options ?? {});
    controller.pollSubscribers.set(subscriptionId, {
      ...(normalizedOptions.resolveIntervalMs
        ? {
            resolveIntervalMs: normalizedOptions.resolveIntervalMs as (
              data: unknown,
            ) => number | false,
          }
        : {}),
      ...(normalizedOptions.shouldRefreshOnLifecycle
        ? {
            shouldRefreshOnLifecycle: normalizedOptions.shouldRefreshOnLifecycle as (
              context: KeyedQueryLifecycleRefreshContext<unknown>,
            ) => boolean,
          }
        : {}),
    });
    controller.subscriberCount += 1;
    if (shouldFetchOnWatch(controller)) {
      void registry.runController(controller);
    } else if (controller.hasData) {
      registry.schedulePoll(controller);
    }

    return () => {
      const current = registry.controllers.get(compositeKey);
      if (!current) {
        return;
      }
      current.subscriberCount = Math.max(0, current.subscriberCount - 1);
      current.pollSubscribers.delete(subscriptionId);
      if (current.subscriberCount <= 0) {
        registry.clearPollTimer(current);
        registry.scheduleGc(current);
      } else {
        registry.schedulePoll(current);
      }
    };
  }

  function refresh(input: TInput): void {
    const compositeKey = compositeKeyFor(input);
    if (compositeKey === null) return;
    const controller = registry.controllers.get(compositeKey);
    if (!controller) return;
    controller.lastFetchedAt = 0;
    void registry.runController(controller);
  }

  async function refreshAsync(input: TInput): Promise<TState> {
    const compositeKey = compositeKeyFor(input);
    if (compositeKey === null) return registry.initialState;
    const controller = registry.controllers.get(compositeKey);
    if (!controller) return registry.getQueryState(compositeKey);
    controller.lastFetchedAt = 0;
    await registry.runController(controller);
    return registry.getQueryState(compositeKey);
  }

  function updateData(input: TInput, updater: (current: TData | null) => TData | null): void {
    const compositeKey = compositeKeyFor(input);
    if (compositeKey === null) {
      return;
    }
    const current = registry.getQueryState(compositeKey) as TState & { data: TData | null };
    const next = updater(current.data);
    if (next === current.data) {
      return;
    }
    registry.setQueryState(compositeKey, {
      ...current,
      data: next,
      isLoading: false,
      isFetching: false,
      error: null,
    } as TState);
    const controller = registry.controllers.get(compositeKey);
    if (controller) {
      // Supersede reads already in flight: they started before this write, so
      // publishing their result would silently revert it (e.g. an optimistic
      // update overwritten by a poll that was racing the mutation).
      registry.markLocalWrite(controller);
      controller.hasData = next !== null;
      registry.schedulePoll(controller);
    }
  }

  return {
    targetKey: compositeKeyFor,
    atomFor,
    snapshotFor,
    watch,
    refresh,
    refreshAsync,
    updateData,
  };
}
