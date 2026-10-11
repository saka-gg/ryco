import type {
  EnvironmentApi,
  EnvironmentId,
  FilesystemBrowseResult,
  ProjectSearchEntriesResult,
} from "@ryco/contracts";
import { Atom } from "effect/reactivity";

import { ensureEnvironmentApi, readEnvironmentApi } from "~/environmentApi";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";

export const DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT = 80;
export const DEFAULT_PROJECT_SEARCH_ENTRIES_STALE_TIME_MS = 15_000;

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
  inFlightQuery: string | null;
  lastInput: ResolvedProjectSearchEntriesInput | null;
  observerCount: number;
  readonly cache: Map<string, CacheEntry>;
}

const INITIAL_PROJECT_SEARCH_ENTRIES_STATE: ProjectSearchEntriesState = Object.freeze({
  data: null,
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

function getScopeKey(environmentId: EnvironmentId, cwd: string, limit: number): string {
  return `${environmentId}::${cwd}::${limit}`;
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

function resolveInput(input: ProjectSearchEntriesInput): ResolvedProjectSearchEntriesInput | null {
  const enabled =
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.query.length > 0;
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
      cache: new Map(),
    };
    scopeRuntimes.set(scopeKey, runtime);
  }
  return runtime;
}

function setState(scopeKey: string, next: ProjectSearchEntriesState): void {
  const atom = projectSearchEntriesStateAtom(scopeKey);
  const current = appAtomRegistry.get(atom);
  if (
    current.data === next.data &&
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
    isLoading: current.data === null,
    isFetching: true,
    error: null,
  });
}

function commitResult(scopeKey: string, result: ProjectSearchEntriesResult): void {
  setState(scopeKey, {
    data: result,
    isLoading: false,
    isFetching: false,
    error: null,
  });
}

function commitError(scopeKey: string, error: Error): void {
  const current = appAtomRegistry.get(projectSearchEntriesStateAtom(scopeKey));
  setState(scopeKey, {
    data: current.data,
    isLoading: false,
    isFetching: false,
    error,
  });
}

function startFetch(
  scopeKey: string,
  runtime: ScopeRuntime,
  resolved: ResolvedProjectSearchEntriesInput,
): void {
  const query = resolved.query;
  const token = ++runtime.token;
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
    .searchEntries({ cwd: resolved.cwd, query, limit: resolved.limit })
    .then((result) => {
      runtime.cache.set(query, { result, fetchedAt: Date.now() });
      if (runtime.token !== token) {
        return;
      }
      runtime.inFlightQuery = null;
      commitResult(scopeKey, result);
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

  if (!options?.force) {
    const cached = runtime.cache.get(resolved.query);
    if (cached && Date.now() - cached.fetchedAt < resolved.staleTime) {
      commitResult(scopeKey, cached.result);
      return;
    }
    if (runtime.inFlightQuery === resolved.query) {
      return;
    }
  }

  startFetch(scopeKey, runtime, resolved);
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
 * environment and/or working directory. Mounted scopes (those with active
 * observers) refetch their last requested query immediately; idle scopes only
 * drop their cache so the next request fetches fresh data. This mirrors React
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

const BROWSE_KEY_SEP = "\u0000";
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

function resolveFilesystemBrowseInput(
  input: FilesystemBrowseInput,
): ResolvedFilesystemBrowseInput | null {
  const enabled =
    (input.enabled ?? true) && input.environmentId !== null && input.partialPath.length > 0;
  if (!enabled || input.environmentId === null) {
    return null;
  }
  const cwd = input.cwd ?? null;
  const compositeKey = `${input.environmentId}${BROWSE_KEY_SEP}${cwd ?? ""}${BROWSE_KEY_SEP}${input.partialPath}`;
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
  appAtomRegistry.set(filesystemBrowseStateAtom(compositeKey), next);
}

function getFilesystemBrowseState(compositeKey: string): FilesystemBrowseState {
  return appAtomRegistry.get(filesystemBrowseStateAtom(compositeKey));
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
      error: new Error("The environment is temporarily unavailable. Reconnecting…"),
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
  triggerFilesystemBrowseFetch(resolved);

  return () => {
    const current = browseControllers.get(resolved.compositeKey);
    if (current && current.subscriberCount > 0) {
      const targetBeforeRemoval = Array.from(current.subscriberTargets.values()).at(-1);
      current.subscriberTargets.delete(subscriber);
      const targetAfterRemoval = Array.from(current.subscriberTargets.values()).at(-1);
      if (targetBeforeRemoval !== targetAfterRemoval && current.fetching) {
        current.fetchToken += 1;
        current.fetching = false;
      }
      current.subscriberCount -= 1;
    }
  };
}

export function prefetchFilesystemBrowse(input: FilesystemBrowseInput): void {
  requestFilesystemBrowse(input);
}

export function clearProjectAtomState(): void {
  for (const key of knownScopeKeys) {
    appAtomRegistry.set(projectSearchEntriesStateAtom(key), INITIAL_PROJECT_SEARCH_ENTRIES_STATE);
  }
  knownScopeKeys.clear();
  scopeRuntimes.clear();
  for (const controller of browseControllers.values()) {
    controller.fetchToken += 1;
  }
  browseControllers.clear();
  for (const key of knownBrowseKeys) {
    appAtomRegistry.set(filesystemBrowseStateAtom(key), INITIAL_FILESYSTEM_BROWSE_STATE);
  }
  knownBrowseKeys.clear();
}

export const resetProjectAtomsForTests = clearProjectAtomState;
