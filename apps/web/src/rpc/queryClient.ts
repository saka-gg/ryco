import {
  type ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import type { EnvironmentId } from "@ryco/contracts";
import { isAwaitingAdmission } from "@ryco/client-runtime/rpc";
import { createVisibilityAwarePoller } from "../lib/visibilityPolling";
import { webAppLifecycle } from "../platform/appLifecycle";

/**
 * Minimal, self-contained replacement for the slice of `@tanstack/react-query`
 * that the web app still relies on. It preserves the observable surface of
 * `useQuery`, `useMutation`, `useQueryClient`, and `queryOptions`
 * (loading/error/data state, stale-time gating, `refetchInterval` polling,
 * prefix-scoped invalidation, optimistic mutations, and imperative
 * `fetchQuery`/`setQueryData`) without pulling in the external dependency.
 *
 * It is intentionally framework-light: queries are cached in a plain `Map` and
 * components subscribe through `useSyncExternalStore`. There is no React
 * context or provider — `useQueryClient` always returns the shared default
 * client, so the previous `QueryClientProvider` wiring is no longer required.
 */

export type QueryKey = ReadonlyArray<unknown>;

type QueryStatus = "pending" | "error" | "success";
type FetchStatus = "fetching" | "idle";

interface QueryState {
  readonly data: unknown;
  readonly error: Error | null;
  readonly status: QueryStatus;
  readonly fetchStatus: FetchStatus;
  readonly dataUpdatedAt: number;
  readonly errorUpdatedAt: number;
}

const INITIAL_QUERY_STATE: QueryState = Object.freeze({
  data: undefined,
  error: null,
  status: "pending",
  fetchStatus: "idle",
  dataUpdatedAt: 0,
  errorUpdatedAt: 0,
});

interface QueryEntry {
  readonly key: QueryKey;
  readonly hash: string;
  state: QueryState;
  readonly listeners: Set<() => void>;
  readonly observers: Set<QueryObserver>;
  promise: Promise<unknown> | null;
  /** A forced fetch joined the in-flight attempt after it was issued. */
  forcedWhileFetching: boolean;
  fetchId: number;
  /**
   * Issue order of the fetch attempt whose result is the current data; 0 when
   * the data did not come from a fetch, was invalidated, or there is none.
   */
  dataReadSequence: number;
  gcTime: number;
  lastAccessedAt: number;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

interface QueryObserver {
  readonly environmentId?: EnvironmentId;
  readonly staleTime?: number;
  readonly refetch: () => unknown;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .toSorted()
        .reduce<Record<string, unknown>>((acc, propertyKey) => {
          acc[propertyKey] = (val as Record<string, unknown>)[propertyKey];
          return acc;
        }, {});
    }
    return val;
  });
}

export function hashQueryKey(key: QueryKey): string {
  return stableStringify(key);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function resolveRetryCount(retry: number | boolean | undefined): number {
  if (retry === undefined) return 3;
  if (retry === true) return 3;
  if (retry === false) return 0;
  return retry;
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyMatchesPrefix(key: QueryKey, prefix: QueryKey): boolean {
  if (prefix.length > key.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (stableStringify(key[index]) !== stableStringify(prefix[index])) {
      return false;
    }
  }
  return true;
}

export interface FetchQueryOptions<TData = unknown> {
  readonly queryKey: QueryKey;
  readonly queryFn: () => Promise<TData>;
  readonly staleTime?: number;
  readonly gcTime?: number;
  readonly retry?: number | boolean;
}

interface InvalidateFilters {
  readonly queryKey?: QueryKey;
}

export class QueryClient {
  private readonly cache = new Map<string, QueryEntry>();
  private readonly prefixIndex = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly defaultGcTime: number;
  /** Issue order of fetch attempts. */
  private readSequence = 0;
  /**
   * Per environment, the last attempt issued before its latest fence; reads
   * issued after it belong to the environment's current session.
   */
  private readonly readEpochs = new Map<EnvironmentId, number>();

  constructor(options?: { readonly maxEntries?: number; readonly defaultGcTime?: number }) {
    this.maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? 512));
    this.defaultGcTime = Math.max(0, options?.defaultGcTime ?? 5 * 60_000);
  }

  private prefixHash(key: QueryKey): string {
    return stableStringify(key);
  }

  private indexEntry(entry: QueryEntry): void {
    for (let length = 1; length <= entry.key.length; length += 1) {
      const prefix = this.prefixHash(entry.key.slice(0, length));
      const hashes = this.prefixIndex.get(prefix) ?? new Set<string>();
      hashes.add(entry.hash);
      this.prefixIndex.set(prefix, hashes);
    }
  }

  private unindexEntry(entry: QueryEntry): void {
    for (let length = 1; length <= entry.key.length; length += 1) {
      const prefix = this.prefixHash(entry.key.slice(0, length));
      const hashes = this.prefixIndex.get(prefix);
      if (!hashes) continue;
      hashes.delete(entry.hash);
      if (hashes.size === 0) this.prefixIndex.delete(prefix);
    }
  }

  private clearGcTimer(entry: QueryEntry): void {
    if (entry.gcTimer !== null) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }
  }

  private isPinned(entry: QueryEntry): boolean {
    return entry.listeners.size > 0 || entry.observers.size > 0 || entry.promise !== null;
  }

  private removeEntry(entry: QueryEntry): boolean {
    if (this.cache.get(entry.hash) !== entry || this.isPinned(entry)) return false;
    this.clearGcTimer(entry);
    entry.fetchId += 1;
    entry.state = INITIAL_QUERY_STATE;
    entry.dataReadSequence = 0;
    this.cache.delete(entry.hash);
    this.unindexEntry(entry);
    return true;
  }

  private scheduleGc(entry: QueryEntry): void {
    this.clearGcTimer(entry);
    if (this.isPinned(entry) || entry.gcTime === Infinity) return;
    if (entry.gcTime === 0) {
      this.removeEntry(entry);
      return;
    }
    entry.gcTimer = setTimeout(() => {
      entry.gcTimer = null;
      this.removeEntry(entry);
    }, entry.gcTime);
  }

  private touch(entry: QueryEntry): void {
    entry.lastAccessedAt = Date.now();
    this.clearGcTimer(entry);
  }

  private evictToCapacity(): void {
    if (this.cache.size <= this.maxEntries) return;
    const candidates = [...this.cache.values()]
      .filter((entry) => !this.isPinned(entry))
      .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    for (const entry of candidates) {
      if (this.cache.size <= this.maxEntries) break;
      this.removeEntry(entry);
    }
  }

  private ensureEntry(key: QueryKey): QueryEntry {
    const hash = hashQueryKey(key);
    let entry = this.cache.get(hash);
    if (!entry) {
      entry = {
        key,
        hash,
        state: INITIAL_QUERY_STATE,
        listeners: new Set(),
        observers: new Set(),
        promise: null,
        forcedWhileFetching: false,
        fetchId: 0,
        dataReadSequence: 0,
        gcTime: this.defaultGcTime,
        lastAccessedAt: Date.now(),
        gcTimer: null,
      };
      this.cache.set(hash, entry);
      this.indexEntry(entry);
      this.evictToCapacity();
    }
    this.touch(entry);
    return entry;
  }

  setGcTime(key: QueryKey, gcTime: number | undefined): void {
    const entry = this.ensureEntry(key);
    entry.gcTime = Math.max(0, gcTime ?? this.defaultGcTime);
    if (!this.isPinned(entry)) this.scheduleGc(entry);
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  getEntry(key: QueryKey): QueryEntry {
    return this.ensureEntry(key);
  }

  getEntryByHash(hash: string): QueryEntry | undefined {
    return this.cache.get(hash);
  }

  getState(key: QueryKey): QueryState {
    return this.ensureEntry(key).state;
  }

  private setState(entry: QueryEntry, next: QueryState): void {
    entry.state = next;
    for (const listener of entry.listeners) {
      listener();
    }
  }

  subscribe(key: QueryKey, listener: () => void): () => void {
    const entry = this.ensureEntry(key);
    entry.listeners.add(listener);
    this.clearGcTimer(entry);
    return () => {
      entry.listeners.delete(listener);
      this.scheduleGc(entry);
    };
  }

  addObserver(key: QueryKey, observer: QueryObserver): () => void {
    const entry = this.ensureEntry(key);
    entry.observers.add(observer);
    this.clearGcTimer(entry);
    return () => {
      entry.observers.delete(observer);
      this.scheduleGc(entry);
    };
  }

  isStale(key: QueryKey, staleTime: number): boolean {
    const entry = this.ensureEntry(key);
    if (entry.state.status !== "success") return true;
    if (staleTime === Infinity) return false;
    return Date.now() - entry.state.dataUpdatedAt >= staleTime;
  }

  getQueryData<TData = unknown>(key: QueryKey): TData | undefined {
    const entry = this.cache.get(hashQueryKey(key));
    return entry?.state.status === "success" ? (entry.state.data as TData) : undefined;
  }

  setQueryData<TData = unknown>(
    key: QueryKey,
    updater: TData | undefined | ((previous: TData | undefined) => TData | undefined),
  ): TData | undefined {
    const entry = this.ensureEntry(key);
    const previous = entry.state.status === "success" ? (entry.state.data as TData) : undefined;
    const next =
      typeof updater === "function"
        ? (updater as (previous: TData | undefined) => TData | undefined)(previous)
        : updater;
    // Mirror React Query: returning `undefined` from the updater is a no-op.
    if (next === undefined) {
      return previous;
    }
    entry.dataReadSequence = 0;
    this.setState(entry, {
      data: next,
      error: null,
      status: "success",
      fetchStatus: "idle",
      dataUpdatedAt: Date.now(),
      errorUpdatedAt: entry.state.errorUpdatedAt,
    });
    this.scheduleGc(entry);
    return next;
  }

  cancelQueries(filters: InvalidateFilters = {}): Promise<void> {
    const prefix = filters.queryKey;
    for (const entry of this.cache.values()) {
      if (prefix && !keyMatchesPrefix(entry.key, prefix)) continue;
      entry.fetchId += 1;
      entry.promise = null;
      if (entry.state.fetchStatus === "fetching") {
        this.setState(entry, { ...entry.state, fetchStatus: "idle" });
      }
    }
    return Promise.resolve();
  }

  invalidateQueries(filters: InvalidateFilters = {}): Promise<void> {
    const prefix = filters.queryKey;
    const entries = prefix
      ? [...(this.prefixIndex.get(this.prefixHash(prefix)) ?? [])]
          .map((hash) => this.cache.get(hash))
          .filter((entry): entry is QueryEntry => entry !== undefined)
      : [...this.cache.values()];
    for (const entry of entries) {
      // Mark stale so the next mount/fetch refetches even without observers.
      entry.dataReadSequence = 0;
      if (entry.state.status === "success") {
        this.setState(entry, { ...entry.state, dataUpdatedAt: 0 });
      }
      if (entry.observers.size > 0) {
        for (const observer of entry.observers) {
          void observer.refetch();
        }
      }
    }
    return Promise.resolve();
  }

  /**
   * Fences the environment's observed queries in flight and starts a new read
   * epoch for it: reads issued from now on belong to its current session.
   */
  fenceActiveQueriesForEnvironment(environmentId: EnvironmentId): void {
    this.readEpochs.set(environmentId, this.readSequence);
    for (const entry of this.cache.values()) {
      if (![...entry.observers].some((observer) => observer.environmentId === environmentId)) {
        continue;
      }
      entry.fetchId += 1;
      entry.promise = null;
      if (entry.state.fetchStatus === "fetching") {
        this.setState(entry, { ...entry.state, fetchStatus: "idle" });
      }
    }
  }

  /**
   * Re-runs the environment's observed queries that failed or are stale, except
   * a query whose current data was fetched after the environment's latest
   * fence: that read already answered from the current session.
   */
  async refreshActiveQueriesForEnvironment(environmentId: EnvironmentId): Promise<void> {
    const epoch = this.readEpochs.get(environmentId);
    const refreshes: Array<Promise<unknown>> = [];
    for (const entry of this.cache.values()) {
      const observers = [...entry.observers].filter(
        (candidate) => candidate.environmentId === environmentId,
      );
      const observer = observers[0];
      if (!observer) continue;
      if (
        epoch !== undefined &&
        entry.state.status === "success" &&
        entry.dataReadSequence > epoch
      ) {
        continue;
      }
      if (
        entry.state.status !== "error" &&
        !observers.some((candidate) => this.isStale(entry.key, candidate.staleTime ?? 0))
      ) {
        continue;
      }
      refreshes.push(Promise.resolve(observer.refetch()).catch(() => undefined));
    }
    await Promise.all(refreshes);
  }

  async fetch<TData>(
    key: QueryKey,
    queryFn: () => Promise<TData>,
    options: {
      readonly retry?: number | boolean | undefined;
      readonly force?: boolean | undefined;
    } = {},
  ): Promise<TData | undefined> {
    const entry = this.ensureEntry(key);
    if (entry.promise) {
      if (options.force === true) entry.forcedWhileFetching = true;
      return entry.promise as Promise<TData | undefined>;
    }

    const fetchId = ++entry.fetchId;
    entry.forcedWhileFetching = false;
    const retries = resolveRetryCount(options.retry);
    this.setState(entry, { ...entry.state, fetchStatus: "fetching", error: null });

    const run = async (): Promise<TData | undefined> => {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const readSequence = ++this.readSequence;
          const data = await queryFn();
          if (entry.fetchId !== fetchId) {
            return entry.state.status === "success" ? (entry.state.data as TData) : undefined;
          }
          entry.dataReadSequence = readSequence;
          this.setState(entry, {
            data,
            error: null,
            status: "success",
            fetchStatus: "idle",
            dataUpdatedAt: Date.now(),
            errorUpdatedAt: entry.state.errorUpdatedAt,
          });
          return data;
        } catch (rawError) {
          if (entry.fetchId !== fetchId) {
            return undefined;
          }
          // A read refused until the hosted session is ready is not retried on a
          // timer: the post-ready refresh re-runs failed queries at once, and a
          // backoff sleep here would hold that refresh (it joins this attempt).
          const awaitingAdmission = isAwaitingAdmission(rawError);
          if (awaitingAdmission && entry.forcedWhileFetching) {
            // That refresh joined this attempt after it was refused: run it
            // again now rather than leave the query failed until the next one.
            entry.forcedWhileFetching = false;
            attempt -= 1;
            continue;
          }
          if (attempt >= retries || awaitingAdmission) {
            const error = toError(rawError);
            this.setState(entry, {
              data: entry.state.data,
              error,
              status: "error",
              fetchStatus: "idle",
              dataUpdatedAt: entry.state.dataUpdatedAt,
              errorUpdatedAt: Date.now(),
            });
            throw error;
          }
          await sleep(retryDelay(attempt));
          if (entry.fetchId !== fetchId) {
            return undefined;
          }
        }
      }
      return undefined;
    };

    const promise = run().finally(() => {
      if (entry.promise === promise) {
        entry.promise = null;
        this.scheduleGc(entry);
        this.evictToCapacity();
      }
    });
    entry.promise = promise as Promise<unknown>;
    return promise;
  }

  async fetchQuery<TData>(options: FetchQueryOptions<TData>): Promise<TData> {
    this.setGcTime(options.queryKey, options.gcTime);
    const staleTime = options.staleTime ?? 0;
    if (!this.isStale(options.queryKey, staleTime)) {
      return this.getQueryData<TData>(options.queryKey) as TData;
    }
    const result = await this.fetch(options.queryKey, options.queryFn, {
      retry: options.retry,
      force: true,
    });
    return result as TData;
  }

  async prefetchQuery<TData>(options: FetchQueryOptions<TData>): Promise<void> {
    try {
      await this.fetchQuery(options);
    } catch {
      // Prefetch failures are non-fatal.
    }
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      this.clearGcTimer(entry);
      entry.fetchId += 1;
      entry.state = INITIAL_QUERY_STATE;
      entry.dataReadSequence = 0;
    }
    this.cache.clear();
    this.prefixIndex.clear();
    this.readEpochs.clear();
  }
}

export const defaultQueryClient = new QueryClient();

export function useQueryClient(): QueryClient {
  return defaultQueryClient;
}

/**
 * Compatibility passthrough. Queries resolve against the shared
 * {@link defaultQueryClient}, so no React context is required; this component
 * exists only so existing call sites (and test harnesses) that wrap their tree
 * in a provider keep working without changes.
 */
export function QueryClientProvider(props: {
  readonly client?: QueryClient;
  readonly children?: ReactNode;
}): ReactNode {
  return props.children ?? null;
}

// ---------------------------------------------------------------------------
// queryOptions
// ---------------------------------------------------------------------------

export interface UseQueryOptions<TQueryFnData = unknown, TData = TQueryFnData> {
  readonly queryKey: QueryKey;
  readonly queryFn: () => Promise<TQueryFnData>;
  readonly environmentId?: EnvironmentId | null;
  readonly enabled?: boolean;
  readonly staleTime?: number;
  readonly gcTime?: number;
  readonly refetchOnMount?: boolean | "always";
  readonly refetchInterval?:
    | number
    | false
    | ((query: { readonly state: { readonly data: TData | undefined } }) => number | false);
  readonly retry?: number | boolean;
  readonly select?: (data: TQueryFnData) => TData;
}

export function queryOptions<TQueryFnData = unknown, TData = TQueryFnData>(
  options: UseQueryOptions<TQueryFnData, TData>,
): UseQueryOptions<TQueryFnData, TData> {
  return options;
}

export interface UseQueryResult<TData = unknown> {
  readonly data: TData | undefined;
  readonly error: Error | null;
  readonly status: QueryStatus;
  readonly fetchStatus: FetchStatus;
  readonly isPending: boolean;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly isFetching: boolean;
  readonly isRefetching: boolean;
  readonly isStale: boolean;
  readonly dataUpdatedAt: number;
  readonly refetch: () => Promise<UseQueryResult<TData>>;
}

function useSelectMemo<TQueryFnData, TData>(
  data: TQueryFnData | undefined,
  select: ((data: TQueryFnData) => TData) | undefined,
): TData | undefined {
  const cacheRef = useRef<{ input: TQueryFnData | undefined; output: TData | undefined } | null>(
    null,
  );
  if (data === undefined) {
    return undefined;
  }
  if (!select) {
    return data as unknown as TData;
  }
  const cached = cacheRef.current;
  if (cached && cached.input === data) {
    return cached.output;
  }
  const output = select(data);
  cacheRef.current = { input: data, output };
  return output;
}

function deriveResult<TQueryFnData, TData>(
  client: QueryClient,
  options: UseQueryOptions<TQueryFnData, TData>,
  state: QueryState,
  selected: TData | undefined,
): UseQueryResult<TData> {
  const staleTime = options.staleTime ?? 0;
  const isFetching = state.fetchStatus === "fetching";
  const isPending = state.status === "pending";
  return {
    data: selected,
    error: state.error,
    status: state.status,
    fetchStatus: state.fetchStatus,
    isPending,
    isLoading: isPending && isFetching,
    isError: state.status === "error",
    isSuccess: state.status === "success",
    isFetching,
    isRefetching: isFetching && !isPending,
    isStale: client.isStale(options.queryKey, staleTime),
    dataUpdatedAt: state.dataUpdatedAt,
    refetch: async () => {
      await client.fetch(options.queryKey, options.queryFn, {
        retry: options.retry,
        force: true,
      });
      const nextState = client.getState(options.queryKey);
      const nextSelected =
        nextState.status === "success"
          ? options.select
            ? options.select(nextState.data as TQueryFnData)
            : (nextState.data as unknown as TData)
          : undefined;
      return deriveResult(client, options, nextState, nextSelected);
    },
  };
}

export function useQuery<TQueryFnData = unknown, TData = TQueryFnData>(
  options: UseQueryOptions<TQueryFnData, TData>,
): UseQueryResult<TData> {
  const client = useQueryClient();
  const { queryKey } = options;
  const hash = hashQueryKey(queryKey);
  client.setGcTime(queryKey, options.gcTime);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // `hash` is referenced so the callbacks re-bind to the new cache entry when
  // the query key changes (the key itself is read through `optionsRef`).
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      void hash;
      return client.subscribe(optionsRef.current.queryKey, onStoreChange);
    },
    [client, hash],
  );
  const getSnapshot = useCallback(() => {
    void hash;
    return client.getState(optionsRef.current.queryKey);
  }, [client, hash]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const enabled = options.enabled ?? true;
  const staleTime = options.staleTime ?? 0;
  const refetchOnMount = options.refetchOnMount;

  useEffect(() => {
    if (!enabled) return;
    const current = optionsRef.current;
    const observer: QueryObserver = {
      ...(current.environmentId ? { environmentId: current.environmentId } : {}),
      staleTime: current.staleTime ?? 0,
      refetch: () =>
        client.fetch(current.queryKey, current.queryFn, { retry: current.retry, force: true }),
    };
    const removeObserver = client.addObserver(current.queryKey, observer);

    const shouldForce = refetchOnMount === "always";
    if (shouldForce || client.isStale(current.queryKey, staleTime)) {
      // A failure is recorded in the query state; only keep it from surfacing as unhandled.
      client
        .fetch(current.queryKey, current.queryFn, { retry: current.retry, force: shouldForce })
        .catch(() => undefined);
    }
    return removeObserver;
  }, [client, hash, enabled, staleTime, refetchOnMount]);

  // refetchInterval polling. Re-runs whenever the cached state changes so the
  // function form can recompute the interval from the latest data, and so a
  // completed fetch reschedules the next poll.
  useEffect(() => {
    if (!enabled) return;
    const current = optionsRef.current;
    const interval = current.refetchInterval;
    if (interval === undefined || interval === false) return;
    const ms =
      typeof interval === "function"
        ? interval({ state: { data: client.getQueryData<TData>(current.queryKey) } })
        : interval;
    if (ms === false || ms === undefined || ms <= 0) return;
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: () =>
        client.fetch(current.queryKey, current.queryFn, { retry: current.retry, force: true }),
      resolveDelayMs: () => ms,
      runImmediately: false,
      jitterRatio: 0.05,
    });
    return poller.stop;
  }, [client, hash, enabled, state]);

  const selected = useSelectMemo(
    state.status === "success" ? (state.data as TQueryFnData) : undefined,
    options.select,
  );

  return deriveResult(client, options, state, selected);
}

// ---------------------------------------------------------------------------
// useMutation
// ---------------------------------------------------------------------------

export interface UseMutationOptions<TData, TVariables, TContext> {
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  readonly onMutate?: (variables: TVariables) => Promise<TContext> | TContext;
  readonly onError?: (
    error: Error,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
  readonly onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
  readonly onSettled?: (
    data: TData | undefined,
    error: Error | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown;
}

type MutationStatus = "idle" | "pending" | "error" | "success";

export interface MutateCallbacks<TData, TVariables> {
  readonly onSuccess?: (data: TData, variables: TVariables) => unknown;
  readonly onError?: (error: Error, variables: TVariables) => unknown;
  readonly onSettled?: (
    data: TData | undefined,
    error: Error | null,
    variables: TVariables,
  ) => unknown;
}

export interface UseMutationResult<TData, TVariables> {
  readonly mutate: (variables: TVariables, callbacks?: MutateCallbacks<TData, TVariables>) => void;
  readonly mutateAsync: (variables: TVariables) => Promise<TData>;
  readonly isPending: boolean;
  readonly isIdle: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly status: MutationStatus;
  readonly error: Error | null;
  readonly data: TData | undefined;
  readonly variables: TVariables | undefined;
  readonly reset: () => void;
}

interface MutationState<TData, TVariables> {
  readonly status: MutationStatus;
  readonly data: TData | undefined;
  readonly error: Error | null;
  readonly variables: TVariables | undefined;
}

const INITIAL_MUTATION_STATE: MutationState<unknown, unknown> = Object.freeze({
  status: "idle",
  data: undefined,
  error: null,
  variables: undefined,
});

export function useMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TVariables, TContext>,
): UseMutationResult<TData, TVariables> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateRef = useRef<MutationState<TData, TVariables>>(
    INITIAL_MUTATION_STATE as MutationState<TData, TVariables>,
  );
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setState = useCallback((next: MutationState<TData, TVariables>) => {
    stateRef.current = next;
    if (mountedRef.current) {
      forceRender();
    }
  }, []);

  const runMutation = useCallback(
    async (
      variables: TVariables,
      callbacks?: MutateCallbacks<TData, TVariables>,
    ): Promise<TData> => {
      const current = optionsRef.current;
      setState({ status: "pending", data: undefined, error: null, variables });
      let context: TContext | undefined;
      try {
        context = current.onMutate ? await current.onMutate(variables) : undefined;
        const data = await current.mutationFn(variables);
        await current.onSuccess?.(data, variables, context);
        await callbacks?.onSuccess?.(data, variables);
        await current.onSettled?.(data, null, variables, context);
        await callbacks?.onSettled?.(data, null, variables);
        setState({ status: "success", data, error: null, variables });
        return data;
      } catch (rawError) {
        const error = toError(rawError);
        await current.onError?.(error, variables, context);
        await callbacks?.onError?.(error, variables);
        await current.onSettled?.(undefined, error, variables, context);
        await callbacks?.onSettled?.(undefined, error, variables);
        setState({ status: "error", data: undefined, error, variables });
        throw error;
      }
    },
    [setState],
  );

  const mutateAsync = useCallback(
    (variables: TVariables): Promise<TData> => runMutation(variables),
    [runMutation],
  );

  const mutate = useCallback(
    (variables: TVariables, callbacks?: MutateCallbacks<TData, TVariables>) => {
      void runMutation(variables, callbacks).catch(() => undefined);
    },
    [runMutation],
  );

  const reset = useCallback(() => {
    setState(INITIAL_MUTATION_STATE as MutationState<TData, TVariables>);
  }, [setState]);

  const state = stateRef.current;
  return {
    mutate,
    mutateAsync,
    isPending: state.status === "pending",
    isIdle: state.status === "idle",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    status: state.status,
    error: state.error,
    data: state.data,
    variables: state.variables,
    reset,
  };
}
