import type {
  EnvironmentApi,
  EnvironmentId,
  FilesystemBrowseResult,
  ProjectSearchEntriesResult,
} from "@ryco/contracts";
import * as Atom from "effect/reactivity/Atom";
import { LRUCache } from "@ryco/shared/lruCache";
import {
  normalizeWorkspaceEntryQuery,
  rankWorkspaceEntries,
} from "@ryco/shared/workspaceEntrySearch";

import { isHostedHubMode } from "~/env";
import { ensureEnvironmentApi, readEnvironmentApi } from "~/environmentApi";
import { hostedHubStore } from "~/hostedHub/state";
import {
  appAtomRegistry,
  createRetainedKeyTracker,
  KEY_SEP,
  type RetainedKeyTracker,
} from "@ryco/client-runtime/rpc";

export const DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT = 80;
export const DEFAULT_PROJECT_SEARCH_ENTRIES_STALE_TIME_MS = 15_000;
/** Cached results kept per scope (environment + cwd + limit), least recently used first out. */
const PROJECT_SEARCH_ENTRIES_CACHE_MAX_QUERIES = 64;
const PROJECT_SEARCH_ENTRIES_CACHE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * A result answered from an index the server is rebuilding is asked again
 * after this long while its path menu stays open, so the menu settles on the
 * rebuilt index (for example a turn's new files) without another keystroke.
 */
const PROJECT_SEARCH_ENTRIES_REFRESHING_REFETCH_MS = 400;
const PROJECT_SEARCH_ENTRIES_REFRESHING_MAX_REFETCHES = 5;

export const EMPTY_PROJECT_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = Object.freeze({
  entries: [],
  truncated: false,
});

/**
 * Reactive state for a project entry search scope. Mirrors the observable
 * surface previously provided by React Query's `useQuery`:
 * - `data` keeps the most recently committed result while a new query loads
 *   (the former `placeholderData: (previous) => previous` behavior).
 * - `isLoading` is only true while the first result for a scope is in flight.
 * - `isFetching` is true whenever a request is in flight.
 */
export interface ProjectSearchEntriesState {
  readonly data: ProjectSearchEntriesResult | null;
  /** The normalized query `data` answers (it can lag the latest request). */
  readonly dataQuery: string | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * Identity of a project search scope: results are cached and retained per
 * environment + working directory + result limit, independent of the query.
 */
export interface ProjectSearchEntriesScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly limit?: number;
}

export interface ProjectSearchEntriesInput extends ProjectSearchEntriesScope {
  readonly query: string;
  readonly enabled?: boolean;
  readonly staleTime?: number;
}

interface ResolvedProjectSearchEntriesInput {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
  readonly staleTime: number;
}

interface CacheEntry {
  readonly result: ProjectSearchEntriesResult;
  readonly fetchedAt: number;
}

interface ScopeRuntime {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly limit: number;
  token: number;
  /** Normalized query of the request in flight. */
  inFlightQuery: string | null;
  lastInput: ResolvedProjectSearchEntriesInput | null;
  /** Mounted observers with an open path menu; only they refetch on invalidation. */
  observerCount: number;
  /** Keyed by normalized query: the server answers equal normalized queries identically. */
  readonly cache: LRUCache<CacheEntry>;
  /** Pending re-request of a result that came from an index being rebuilt. */
  refreshingRefetchTimer: ReturnType<typeof setTimeout> | null;
}

const INITIAL_PROJECT_SEARCH_ENTRIES_STATE: ProjectSearchEntriesState = Object.freeze({
  data: null,
  dataQuery: null,
  isLoading: false,
  isFetching: false,
  error: null,
});

export const EMPTY_PROJECT_SEARCH_ENTRIES_STATE = INITIAL_PROJECT_SEARCH_ENTRIES_STATE;

const EMPTY_PROJECT_SEARCH_ENTRIES_ATOM = Atom.make(INITIAL_PROJECT_SEARCH_ENTRIES_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("project-search-entries:null"),
);

const knownScopeKeys = new Set<string>();
const scopeRuntimes = new Map<string, ScopeRuntime>();

const projectSearchEntriesStateAtom = Atom.family((scopeKey: string) => {
  knownScopeKeys.add(scopeKey);
  return Atom.make(INITIAL_PROJECT_SEARCH_ENTRIES_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`project-search-entries:${scopeKey}`),
  );
});

function scopeKeyPrefix(environmentId: EnvironmentId): string {
  return `${environmentId}::`;
}

function getScopeKey(environmentId: EnvironmentId, cwd: string, limit: number): string {
  return `${scopeKeyPrefix(environmentId)}${cwd}::${limit}`;
}

export function resolveProjectSearchEntriesScopeKey(
  scope: ProjectSearchEntriesScope,
): string | null {
  if (scope.environmentId === null || scope.cwd === null) {
    return null;
  }
  return getScopeKey(
    scope.environmentId,
    scope.cwd,
    scope.limit ?? DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT,
  );
}

export function getProjectSearchEntriesStateAtom(scopeKey: string | null) {
  return scopeKey === null
    ? EMPTY_PROJECT_SEARCH_ENTRIES_ATOM
    : projectSearchEntriesStateAtom(scopeKey);
}

/**
 * An empty query is a real request: it lists the workspace's top-level
 * entries and warms the server's index while the user is still typing.
 */
function resolveInput(input: ProjectSearchEntriesInput): ResolvedProjectSearchEntriesInput | null {
  const enabled = (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null;
  if (!enabled || input.environmentId === null || input.cwd === null) {
    return null;
  }
  return {
    environmentId: input.environmentId,
    cwd: input.cwd,
    query: input.query,
    limit: input.limit ?? DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT,
    staleTime: input.staleTime ?? DEFAULT_PROJECT_SEARCH_ENTRIES_STALE_TIME_MS,
  };
}

function ensureScopeRuntime(
  environmentId: EnvironmentId,
  cwd: string,
  limit: number,
): ScopeRuntime {
  const scopeKey = getScopeKey(environmentId, cwd, limit);
  let runtime = scopeRuntimes.get(scopeKey);
  if (!runtime) {
    runtime = {
      environmentId,
      cwd,
      limit,
      token: 0,
      inFlightQuery: null,
      lastInput: null,
      observerCount: 0,
      cache: new LRUCache(
        PROJECT_SEARCH_ENTRIES_CACHE_MAX_QUERIES,
        PROJECT_SEARCH_ENTRIES_CACHE_MAX_BYTES,
      ),
      refreshingRefetchTimer: null,
    };
    scopeRuntimes.set(scopeKey, runtime);
  }
  return runtime;
}

function setState(scopeKey: string, next: ProjectSearchEntriesState): void {
  // `Atom.family` runs its factory once per key, so a key forgotten by a reset
  // is only re-recorded here; otherwise the next reset would miss its atom.
  knownScopeKeys.add(scopeKey);
  const atom = projectSearchEntriesStateAtom(scopeKey);
  const current = appAtomRegistry.get(atom);
  if (
    current.data === next.data &&
    current.dataQuery === next.dataQuery &&
    current.isLoading === next.isLoading &&
    current.isFetching === next.isFetching &&
    current.error === next.error
  ) {
    return;
  }
  appAtomRegistry.set(atom, next);
}

function markFetching(scopeKey: string): void {
  const current = appAtomRegistry.get(projectSearchEntriesStateAtom(scopeKey));
  setState(scopeKey, {
    data: current.data,
    dataQuery: current.dataQuery,
    isLoading: current.data === null,
    isFetching: true,
    error: null,
  });
}

function commitResult(scopeKey: string, result: ProjectSearchEntriesResult, query: string): void {
  setState(scopeKey, {
    data: result,
    dataQuery: query,
    isLoading: false,
    isFetching: false,
    error: null,
  });
}

function commitError(scopeKey: string, error: Error): void {
  const current = appAtomRegistry.get(projectSearchEntriesStateAtom(scopeKey));
  setState(scopeKey, {
    data: current.data,
    dataQuery: current.dataQuery,
    isLoading: false,
    isFetching: false,
    error,
  });
}

function estimateResultBytes(result: ProjectSearchEntriesResult): number {
  let bytes = 64;
  for (const entry of result.entries) {
    bytes += 48 + 2 * (entry.path.length + (entry.parentPath?.length ?? 0));
  }
  return bytes;
}

function readFreshCacheEntry(
  runtime: ScopeRuntime,
  query: string,
  staleTime: number,
): CacheEntry | null {
  const cached = runtime.cache.get(query);
  return cached !== null && Date.now() - cached.fetchedAt < staleTime ? cached : null;
}

/**
 * Answers `query` from a fresh cached result for one of its prefixes when that
 * result is complete (every match returned, from a full index). Every match
 * tier implies a subsequence match of the path, and a query's subsequence
 * matches are a subset of any prefix's, so ranking that result locally with
 * the server's ranking gives exactly the server's answer, with no round trip.
 */
function narrowFromCache(
  runtime: ScopeRuntime,
  query: string,
  staleTime: number,
): CacheEntry | null {
  for (let length = query.length - 1; length >= 0; length -= 1) {
    const prefix = query.slice(0, length);
    const cached = readFreshCacheEntry(runtime, prefix, staleTime);
    if (cached === null) continue;
    // A shorter prefix matches at least as much, so it cannot be complete either.
    if (cached.result.truncated || cached.result.partial === true) return null;
    const ranked = rankWorkspaceEntries(
      cached.result.entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        normalizedPath: entry.path.toLowerCase(),
        entry,
      })),
      query,
      runtime.limit,
    );
    return {
      result: { entries: ranked.entries.map((candidate) => candidate.entry), truncated: false },
      fetchedAt: cached.fetchedAt,
    };
  }
  return null;
}

function clearRefreshingRefetch(runtime: ScopeRuntime): void {
  if (runtime.refreshingRefetchTimer !== null) {
    clearTimeout(runtime.refreshingRefetchTimer);
    runtime.refreshingRefetchTimer = null;
  }
}

/**
 * Re-asks a query whose answer came from an index being rebuilt, while the
 * request is still the scope's latest and a path menu shows it. A closed
 * menu needs nothing: such results are never cached, so reopening refetches.
 */
function scheduleRefreshingRefetch(
  scopeKey: string,
  runtime: ScopeRuntime,
  resolved: ResolvedProjectSearchEntriesInput,
  token: number,
  attempt: number,
): void {
  clearRefreshingRefetch(runtime);
  if (attempt >= PROJECT_SEARCH_ENTRIES_REFRESHING_MAX_REFETCHES) {
    return;
  }
  runtime.refreshingRefetchTimer = setTimeout(() => {
    runtime.refreshingRefetchTimer = null;
    if (
      runtime.token !== token ||
      runtime.observerCount === 0 ||
      scopeRuntimes.get(scopeKey) !== runtime
    ) {
      return;
    }
    startFetch(scopeKey, runtime, resolved, attempt + 1);
  }, PROJECT_SEARCH_ENTRIES_REFRESHING_REFETCH_MS);
}

function startFetch(
  scopeKey: string,
  runtime: ScopeRuntime,
  resolved: ResolvedProjectSearchEntriesInput,
  refreshingAttempt = 0,
): void {
  const query = normalizeWorkspaceEntryQuery(resolved.query);
  const token = ++runtime.token;
  clearRefreshingRefetch(runtime);
  runtime.inFlightQuery = query;
  markFetching(scopeKey);

  let api: ReturnType<typeof ensureEnvironmentApi>;
  try {
    api = ensureEnvironmentApi(resolved.environmentId);
  } catch (error) {
    if (runtime.token === token) {
      runtime.inFlightQuery = null;
      commitError(scopeKey, toError(error));
    }
    return;
  }

  api.projects
    .searchEntries({ cwd: resolved.cwd, query: resolved.query, limit: resolved.limit })
    .then((result) => {
      // An answer from an index that is being rebuilt is shown, never reused.
      if (result.refreshing !== true) {
        runtime.cache.set(query, { result, fetchedAt: Date.now() }, estimateResultBytes(result));
      }
      if (runtime.token !== token) {
        return;
      }
      runtime.inFlightQuery = null;
      commitResult(scopeKey, result, query);
      if (result.refreshing === true) {
        scheduleRefreshingRefetch(scopeKey, runtime, resolved, token, refreshingAttempt);
      }
    })
    .catch((error) => {
      if (runtime.token !== token) {
        return;
      }
      runtime.inFlightQuery = null;
      commitError(scopeKey, toError(error));
    });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Trigger a project entry search for the given input, honoring the same
 * gating, stale-time, and keep-previous-result semantics that the former
 * React Query options provided. Safe to call on every render: identical
 * in-flight queries and fresh cached results are deduplicated.
 */
export function requestProjectSearchEntries(
  input: ProjectSearchEntriesInput,
  options?: { readonly force?: boolean },
): void {
  const resolved = resolveInput(input);
  if (resolved === null) {
    return;
  }

  const scopeKey = getScopeKey(resolved.environmentId, resolved.cwd, resolved.limit);
  const runtime = ensureScopeRuntime(resolved.environmentId, resolved.cwd, resolved.limit);
  runtime.lastInput = resolved;
  const query = normalizeWorkspaceEntryQuery(resolved.query);

  if (!options?.force) {
    let local = readFreshCacheEntry(runtime, query, resolved.staleTime);
    if (local === null) {
      local = narrowFromCache(runtime, query, resolved.staleTime);
      if (local !== null) {
        runtime.cache.set(query, local, estimateResultBytes(local.result));
      }
    }
    if (local !== null) {
      // Supersede any older request still in flight so it cannot overwrite this.
      runtime.token += 1;
      runtime.inFlightQuery = null;
      clearRefreshingRefetch(runtime);
      commitResult(scopeKey, local.result, query);
      return;
    }
    if (runtime.inFlightQuery === query) {
      return;
    }
  }

  startFetch(scopeKey, runtime, resolved);
}

/**
 * Whether `requestProjectSearchEntries` would answer this input from the
 * scope's cache (directly or by narrowing a complete prefix result) without a
 * request, so callers can skip their typing debounce.
 */
export function canResolveProjectSearchEntriesLocally(input: ProjectSearchEntriesInput): boolean {
  const resolved = resolveInput(input);
  if (resolved === null) {
    return false;
  }
  const runtime = scopeRuntimes.get(
    getScopeKey(resolved.environmentId, resolved.cwd, resolved.limit),
  );
  if (!runtime) {
    return false;
  }
  const query = normalizeWorkspaceEntryQuery(resolved.query);
  return (
    readFreshCacheEntry(runtime, query, resolved.staleTime) !== null ||
    narrowFromCache(runtime, query, resolved.staleTime) !== null
  );
}

/** Re-sends the scope's last request, bypassing the cache (an explicit retry). */
export function retryProjectSearchEntries(scope: ProjectSearchEntriesScope): void {
  const scopeKey = resolveProjectSearchEntriesScopeKey(scope);
  const lastInput = scopeKey === null ? null : (scopeRuntimes.get(scopeKey)?.lastInput ?? null);
  if (lastInput !== null) {
    requestProjectSearchEntries(lastInput, { force: true });
  }
}

export function retainProjectSearchEntriesScope(scope: ProjectSearchEntriesScope): void {
  if (scope.environmentId === null || scope.cwd === null) {
    return;
  }
  const runtime = ensureScopeRuntime(
    scope.environmentId,
    scope.cwd,
    scope.limit ?? DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT,
  );
  runtime.observerCount += 1;
}

export function releaseProjectSearchEntriesScope(scope: ProjectSearchEntriesScope): void {
  const scopeKey = resolveProjectSearchEntriesScopeKey(scope);
  if (scopeKey === null) {
    return;
  }
  const runtime = scopeRuntimes.get(scopeKey);
  if (runtime && runtime.observerCount > 0) {
    runtime.observerCount -= 1;
  }
}

/**
 * Invalidate cached project search results, optionally scoped to an
 * environment and/or working directory. Scopes with an open path menu refetch
 * their last requested query immediately; the rest only drop their cache, so
 * the next request (when the menu opens) fetches fresh data. This mirrors React
 * Query's "refetch active queries, mark the rest stale" invalidation.
 */
export function invalidateProjectSearchEntries(input?: {
  readonly environmentId?: EnvironmentId | null;
  readonly cwd?: string | null;
}): void {
  const environmentId = input?.environmentId ?? null;
  const cwd = input?.cwd ?? null;

  for (const runtime of scopeRuntimes.values()) {
    if (environmentId !== null && runtime.environmentId !== environmentId) {
      continue;
    }
    if (cwd !== null && runtime.cwd !== cwd) {
      continue;
    }

    runtime.cache.clear();
    if (runtime.observerCount > 0 && runtime.lastInput !== null) {
      requestProjectSearchEntries(runtime.lastInput, { force: true });
    }
  }
}

export function getProjectSearchEntriesSnapshot(
  input: ProjectSearchEntriesInput,
): ProjectSearchEntriesState {
  const scopeKey = resolveProjectSearchEntriesScopeKey(input);
  if (scopeKey === null) {
    return INITIAL_PROJECT_SEARCH_ENTRIES_STATE;
  }
  return appAtomRegistry.get(projectSearchEntriesStateAtom(scopeKey));
}

// ---------------------------------------------------------------------------
// Filesystem browse (command palette add-project path picker)
// ---------------------------------------------------------------------------

export const DEFAULT_FILESYSTEM_BROWSE_STALE_TIME_MS = 30_000;
/**
 * Browse results kept once nothing observes them. A browse listing is
 * node-owned content that never expires on its own, so only the most recently
 * released ones stay warm for back-navigation.
 */
export const FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT = 16;

export interface FilesystemBrowseInput {
  readonly environmentId: EnvironmentId | null;
  readonly partialPath: string;
  readonly cwd?: string | null;
  readonly enabled?: boolean;
  readonly staleTime?: number;
}

export interface FilesystemBrowseState {
  readonly data: FilesystemBrowseResult | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
  readonly isPending: boolean;
}

const INITIAL_FILESYSTEM_BROWSE_STATE: FilesystemBrowseState = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  error: null,
  isPending: true,
});

export const EMPTY_FILESYSTEM_BROWSE_STATE = INITIAL_FILESYSTEM_BROWSE_STATE;

const knownBrowseKeys = new Set<string>();

const filesystemBrowseStateAtom = Atom.family((compositeKey: string) => {
  knownBrowseKeys.add(compositeKey);
  return Atom.make<FilesystemBrowseState>(INITIAL_FILESYSTEM_BROWSE_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`filesystem-browse:${compositeKey}`),
  );
});

const EMPTY_FILESYSTEM_BROWSE_ATOM = Atom.make<FilesystemBrowseState>(
  INITIAL_FILESYSTEM_BROWSE_STATE,
).pipe(Atom.keepAlive, Atom.withLabel("filesystem-browse:null"));

function browseKeyPrefix(environmentId: EnvironmentId): string {
  return `${environmentId}${KEY_SEP}`;
}

interface ResolvedFilesystemBrowseInput {
  readonly environmentId: EnvironmentId;
  readonly partialPath: string;
  readonly cwd: string | null;
  readonly staleTime: number;
  readonly compositeKey: string;
}

interface BrowseController {
  readonly compositeKey: string;
  readonly environmentId: EnvironmentId;
  readonly partialPath: string;
  readonly cwd: string | null;
  readonly staleTime: number;
  subscriberCount: number;
  lastFetchedAt: number;
  fetchToken: number;
  hasData: boolean;
  fetching: boolean;
  lastResult: FilesystemBrowseResult | null;
  readonly subscriberTargets: Map<symbol, EnvironmentApi | null>;
}

const browseControllers = new Map<string, BrowseController>();

/**
 * Forget one browse entry completely: the controller is dropped, a response
 * still in flight is fenced by the token bump, and the state atom falls back to
 * its initial state so a later read cannot observe evicted node content.
 */
function dropBrowseKey(compositeKey: string): void {
  const controller = browseControllers.get(compositeKey);
  if (controller) {
    controller.fetchToken += 1;
    browseControllers.delete(compositeKey);
  }
  if (knownBrowseKeys.delete(compositeKey)) {
    appAtomRegistry.set(filesystemBrowseStateAtom(compositeKey), INITIAL_FILESYSTEM_BROWSE_STATE);
  }
}

const browseRetention: RetainedKeyTracker = createRetainedKeyTracker({
  limit: FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT,
  onEvict: dropBrowseKey,
  environmentPrefix: browseKeyPrefix,
});

function resolveFilesystemBrowseInput(
  input: FilesystemBrowseInput,
): ResolvedFilesystemBrowseInput | null {
  const enabled =
    (input.enabled ?? true) && input.environmentId !== null && input.partialPath.length > 0;
  if (!enabled || input.environmentId === null) {
    return null;
  }
  const cwd = input.cwd ?? null;
  const compositeKey = `${browseKeyPrefix(input.environmentId)}${cwd ?? ""}${KEY_SEP}${input.partialPath}`;
  return {
    environmentId: input.environmentId,
    partialPath: input.partialPath,
    cwd,
    staleTime: input.staleTime ?? DEFAULT_FILESYSTEM_BROWSE_STALE_TIME_MS,
    compositeKey,
  };
}

export function resolveFilesystemBrowseKey(input: FilesystemBrowseInput): string | null {
  return resolveFilesystemBrowseInput(input)?.compositeKey ?? null;
}

export function getFilesystemBrowseStateAtom(scopeKey: string | null) {
  return scopeKey === null ? EMPTY_FILESYSTEM_BROWSE_ATOM : filesystemBrowseStateAtom(scopeKey);
}

function setFilesystemBrowseState(compositeKey: string, next: FilesystemBrowseState): void {
  // Re-recorded on every write: the atom family only runs its factory once per
  // key, so a key dropped from the index would otherwise escape the next reset.
  knownBrowseKeys.add(compositeKey);
  appAtomRegistry.set(filesystemBrowseStateAtom(compositeKey), next);
}

function getFilesystemBrowseState(compositeKey: string): FilesystemBrowseState {
  return appAtomRegistry.get(filesystemBrowseStateAtom(compositeKey));
}

const ENVIRONMENT_UNAVAILABLE_MESSAGE = "The environment is temporarily unavailable. Reconnecting…";
const HOSTED_ENVIRONMENT_SYNCING_MESSAGE = "Syncing with this node…";

/**
 * A node the signed-in account may use whose connection is not up yet, as after
 * a switch to it: the missing environment API is expected to resolve by itself,
 * unlike a revoked, offline or native-client-only node, which keeps the
 * unavailable copy.
 */
function isHostedEnvironmentSyncing(environmentId: EnvironmentId): boolean {
  if (!isHostedHubMode()) return false;
  const node = hostedHubStore
    .getState()
    .nodes.find((candidate) => candidate.environmentId === environmentId);
  return (
    node !== undefined &&
    node.revokedAt === null &&
    node.presence.online &&
    node.capabilities?.nativeClientRequired !== true
  );
}

async function runBrowseController(controller: BrowseController): Promise<void> {
  const token = ++controller.fetchToken;
  controller.fetching = true;
  const current = getFilesystemBrowseState(controller.compositeKey);
  setFilesystemBrowseState(controller.compositeKey, {
    data: current.data,
    isLoading: current.data === null,
    isFetching: true,
    error: null,
    isPending: true,
  });

  const explicitTarget = Array.from(controller.subscriberTargets.values()).at(-1);
  const api =
    explicitTarget === undefined ? readEnvironmentApi(controller.environmentId) : explicitTarget;
  if (!api) {
    if (token !== controller.fetchToken) {
      return;
    }
    controller.fetching = false;
    setFilesystemBrowseState(controller.compositeKey, {
      data: current.data,
      isLoading: false,
      isFetching: false,
      error: new Error(
        isHostedEnvironmentSyncing(controller.environmentId)
          ? HOSTED_ENVIRONMENT_SYNCING_MESSAGE
          : ENVIRONMENT_UNAVAILABLE_MESSAGE,
      ),
      isPending: false,
    });
    return;
  }

  try {
    const data = await api.filesystem.browse({
      partialPath: controller.partialPath,
      ...(controller.cwd ? { cwd: controller.cwd } : {}),
    });
    if (token !== controller.fetchToken) {
      return;
    }
    controller.fetching = false;
    controller.hasData = true;
    controller.lastFetchedAt = Date.now();
    controller.lastResult = data;
    setFilesystemBrowseState(controller.compositeKey, {
      data,
      isLoading: false,
      isFetching: false,
      error: null,
      isPending: false,
    });
  } catch (error) {
    if (token !== controller.fetchToken) {
      return;
    }
    controller.fetching = false;
    const normalized = toError(error);
    setFilesystemBrowseState(controller.compositeKey, {
      data: getFilesystemBrowseState(controller.compositeKey).data,
      isLoading: false,
      isFetching: false,
      error: normalized,
      isPending: false,
    });
  }
}

function ensureBrowseController(resolved: ResolvedFilesystemBrowseInput): BrowseController {
  let controller = browseControllers.get(resolved.compositeKey);
  if (!controller) {
    controller = {
      compositeKey: resolved.compositeKey,
      environmentId: resolved.environmentId,
      partialPath: resolved.partialPath,
      cwd: resolved.cwd,
      staleTime: resolved.staleTime,
      subscriberCount: 0,
      lastFetchedAt: 0,
      fetchToken: 0,
      hasData: false,
      fetching: false,
      lastResult: null,
      subscriberTargets: new Map(),
    };
    browseControllers.set(resolved.compositeKey, controller);
  }
  return controller;
}

function triggerFilesystemBrowseFetch(resolved: ResolvedFilesystemBrowseInput): void {
  const controller = ensureBrowseController(resolved);
  const isStale =
    controller.hasData && Date.now() - controller.lastFetchedAt >= controller.staleTime;
  if (!controller.fetching && (!controller.hasData || isStale)) {
    void runBrowseController(controller);
  }
}

/**
 * Imperatively warm a filesystem browse path. Safe to call from effects or
 * prefetch handlers; deduplicates in-flight and fresh cached reads.
 */
export function requestFilesystemBrowse(
  input: FilesystemBrowseInput,
  options?: { readonly force?: boolean },
): void {
  const resolved = resolveFilesystemBrowseInput(input);
  if (resolved === null) {
    return;
  }

  const controller = ensureBrowseController(resolved);
  // An entry nobody observes is evictable from the moment it exists.
  if (controller.subscriberCount === 0) browseRetention.release(resolved.compositeKey);
  if (!options?.force) {
    if (controller.hasData && Date.now() - controller.lastFetchedAt < resolved.staleTime) {
      setFilesystemBrowseState(resolved.compositeKey, {
        data: controller.lastResult,
        isLoading: false,
        isFetching: false,
        error: null,
        isPending: false,
      });
      return;
    }
    if (controller.fetching) {
      return;
    }
  }

  void runBrowseController(controller);
}

export function watchFilesystemBrowse(
  input: FilesystemBrowseInput,
  api?: EnvironmentApi | null,
): () => void {
  const resolved = resolveFilesystemBrowseInput(input);
  if (resolved === null) {
    return () => undefined;
  }

  const controller = ensureBrowseController(resolved);
  const subscriber = Symbol("filesystem-browse-subscriber");
  const previousTarget = Array.from(controller.subscriberTargets.values()).at(-1);
  if (api !== undefined) {
    controller.subscriberTargets.set(subscriber, api);
  }
  const currentTarget = Array.from(controller.subscriberTargets.values()).at(-1);
  if (previousTarget !== currentTarget && controller.fetching) {
    controller.fetchToken += 1;
    controller.fetching = false;
  }
  controller.subscriberCount += 1;
  browseRetention.retain(resolved.compositeKey);
  triggerFilesystemBrowseFetch(resolved);

  return () => {
    // A reset or eviction drops the controller. A release that outlived it must
    // not count against a newer controller created for the same key.
    if (browseControllers.get(resolved.compositeKey) !== controller) {
      return;
    }
    if (controller.subscriberCount > 0) {
      const targetBeforeRemoval = Array.from(controller.subscriberTargets.values()).at(-1);
      controller.subscriberTargets.delete(subscriber);
      const targetAfterRemoval = Array.from(controller.subscriberTargets.values()).at(-1);
      if (targetBeforeRemoval !== targetAfterRemoval && controller.fetching) {
        controller.fetchToken += 1;
        controller.fetching = false;
      }
      controller.subscriberCount -= 1;
      if (controller.subscriberCount === 0) {
        browseRetention.release(resolved.compositeKey);
      }
    }
  };
}

export function prefetchFilesystemBrowse(input: FilesystemBrowseInput): void {
  requestFilesystemBrowse(input);
}

/**
 * Resets the search scopes and browse entries of one environment, or of every
 * environment when `environmentId` is null. In-flight responses are fenced so
 * a late answer cannot repopulate what was just cleared.
 */
function resetProjectAtomState(environmentId: EnvironmentId | null): void {
  // An empty prefix matches every key.
  const scopePrefix = environmentId === null ? "" : scopeKeyPrefix(environmentId);
  const browsePrefix = environmentId === null ? "" : browseKeyPrefix(environmentId);

  // Scope keys carry no separate environment identity, so the atoms match on the
  // key prefix; runtimes know their environment and match it exactly.
  for (const key of knownScopeKeys) {
    if (!key.startsWith(scopePrefix)) continue;
    appAtomRegistry.set(projectSearchEntriesStateAtom(key), INITIAL_PROJECT_SEARCH_ENTRIES_STATE);
    knownScopeKeys.delete(key);
  }
  for (const [key, runtime] of scopeRuntimes) {
    if (environmentId !== null && runtime.environmentId !== environmentId) continue;
    clearRefreshingRefetch(runtime);
    runtime.token += 1;
    runtime.inFlightQuery = null;
    scopeRuntimes.delete(key);
  }
  for (const key of new Set([...browseControllers.keys(), ...knownBrowseKeys])) {
    if (key.startsWith(browsePrefix)) dropBrowseKey(key);
  }
  if (environmentId === null) {
    browseRetention.clear();
  } else {
    browseRetention.forgetEnvironment(environmentId);
  }
}

/**
 * Full reset of every environment's project search and filesystem browse state:
 * tests and account teardown.
 */
export function clearProjectAtomState(): void {
  resetProjectAtomState(null);
}

/** Resets the project search and filesystem browse state of one environment only. */
export function clearProjectAtomStateForEnvironment(environmentId: EnvironmentId): void {
  resetProjectAtomState(environmentId);
}

export const resetProjectAtomsForTests = clearProjectAtomState;
