import {
  type EnvironmentId,
  type GitResolvePullRequestResult,
  type VcsListRefsResult,
  type VcsRef,
} from "@ryco/contracts";
import { Atom } from "effect/reactivity";

import { readEnvironmentApi } from "../environmentApi";
import { createVisibilityAwarePoller, type VisibilityAwarePoller } from "../lib/visibilityPolling";
import { webAppLifecycle } from "../platform/appLifecycle";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";

// ---------------------------------------------------------------------------
// Scoped invalidation
//
// Replaces the global `queryClient.invalidateQueries` cache with explicit,
// scoped invalidation keys. Git data lives under `git:${cwd}`; project data
// (worktree listings) lives under `project:${cwd}`.
// ---------------------------------------------------------------------------

export function gitScopeKey(cwd: string | null): string {
  return `git:${cwd ?? ""}`;
}

export function projectScopeKey(cwd: string | null): string {
  return `project:${cwd ?? ""}`;
}

const invalidationListeners = new Map<string, Set<() => void>>();

export function subscribeInvalidationScope(scope: string, listener: () => void): () => void {
  let listeners = invalidationListeners.get(scope);
  if (!listeners) {
    listeners = new Set();
    invalidationListeners.set(scope, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = invalidationListeners.get(scope);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      invalidationListeners.delete(scope);
    }
  };
}

export function invalidateScopes(scopes: Iterable<string>): void {
  const scopeSet = new Set(scopes);
  markBranchesStaleForScopes(scopeSet);
  const notified = new Set<() => void>();
  for (const scope of scopeSet) {
    const listeners = invalidationListeners.get(scope);
    if (!listeners) {
      continue;
    }
    for (const listener of listeners) {
      notified.add(listener);
    }
  }
  for (const listener of notified) {
    listener();
  }
}

// ---------------------------------------------------------------------------
// Mutation running tracker
//
// Replaces `useIsMutating({ mutationKey })`: a per-key counter atom that
// reflects how many mutations with that key are currently in flight. Used to
// share "is this git action running?" state across components (e.g. the
// publish dialog and the surrounding git action controls).
// ---------------------------------------------------------------------------

const knownMutationTrackingKeys = new Set<string>();

const mutationRunningCountAtom = Atom.family((key: string) => {
  knownMutationTrackingKeys.add(key);
  return Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`git-mutation-running:${key}`));
});

export function getMutationRunningAtom(key: string): Atom.Atom<number> {
  return mutationRunningCountAtom(key);
}

export function beginMutationTracking(key: string): void {
  const atom = mutationRunningCountAtom(key);
  appAtomRegistry.set(atom, appAtomRegistry.get(atom) + 1);
}

export function endMutationTracking(key: string): void {
  const atom = mutationRunningCountAtom(key);
  appAtomRegistry.set(atom, Math.max(0, appAtomRegistry.get(atom) - 1));
}

// ---------------------------------------------------------------------------
// Branch (ref) search — paginated
//
// Replaces `gitBranchSearchInfiniteQueryOptions` + `useInfiniteQuery`.
// ---------------------------------------------------------------------------

const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;

export interface GitBranchesState {
  readonly pages: ReadonlyArray<VcsListRefsResult>;
  readonly isPending: boolean;
  readonly isFetchingNextPage: boolean;
  readonly error: Error | null;
}

const EMPTY_BRANCHES_STATE: GitBranchesState = Object.freeze({
  pages: [],
  isPending: false,
  isFetchingNextPage: false,
  error: null,
});

const INITIAL_BRANCHES_STATE: GitBranchesState = Object.freeze({
  ...EMPTY_BRANCHES_STATE,
  isPending: true,
});

export const EMPTY_BRANCHES_ATOM = Atom.make(EMPTY_BRANCHES_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-branches:null"),
);

const knownBranchesKeys = new Set<string>();

const branchesStateAtom = Atom.family((key: string) => {
  knownBranchesKeys.add(key);
  return Atom.make(INITIAL_BRANCHES_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-branches:${key}`),
  );
});

interface BranchesTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
}

interface BranchesController {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly query: string;
  subscriberCount: number;
  loadedPageCount: number;
  lastFetchedAt: number;
  fetchToken: number;
  hasLoadedOnce: boolean;
  inFlightPromise: Promise<void> | null;
  invalidationUnsub: () => void;
  focusListener: (() => void) | null;
  poller: VisibilityAwarePoller | null;
}

const NOOP: () => void = () => undefined;
const branchesControllers = new Map<string, BranchesController>();

function branchesKey(target: { environmentId: EnvironmentId; cwd: string; query: string }): string {
  return `${target.environmentId}\u0000${target.cwd}\u0000${target.query}`;
}

export function getBranchesTargetKey(target: BranchesTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }
  return branchesKey({
    environmentId: target.environmentId,
    cwd: target.cwd,
    query: target.query,
  });
}

export function getBranchesAtom(targetKey: string | null): Atom.Atom<GitBranchesState> {
  return targetKey === null ? EMPTY_BRANCHES_ATOM : branchesStateAtom(targetKey);
}

export function getBranchesSnapshot(targetKey: string | null): GitBranchesState {
  if (targetKey === null) {
    return EMPTY_BRANCHES_STATE;
  }
  return appAtomRegistry.get(branchesStateAtom(targetKey));
}

function setBranchesState(key: string, state: GitBranchesState): void {
  appAtomRegistry.set(branchesStateAtom(key), state);
}

async function fetchRefsPage(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  cursor: number,
): Promise<VcsListRefsResult> {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error("Git refs are unavailable.");
  }
  return api.vcs.listRefs({
    cwd,
    ...(query.length > 0 ? { query } : {}),
    cursor,
    limit: GIT_BRANCHES_PAGE_SIZE,
  });
}

function nextCursorOf(pages: ReadonlyArray<VcsListRefsResult>): number | null {
  const lastPage = pages[pages.length - 1];
  return lastPage ? lastPage.nextCursor : null;
}

// ---------------------------------------------------------------------------
// Shared first-page reads and freshness
//
// The branch selector prefetches the unfiltered list while `useGitBranches`
// subscribes to the same key in the same commit, and every ChatView remount
// used to recreate the controller. Both paths now share one in-flight
// first-page request per key, and a recreated controller adopts a list that
// is still within the stale time instead of refetching it. Each listRefs runs
// several git processes on the server.
// ---------------------------------------------------------------------------

const branchesFirstPageInFlight = new Map<string, Promise<FirstBranchesPageRead>>();
const branchesFetchedAt = new Map<string, number>();
let branchesFetchGeneration = 0;

function isBranchesFetchFresh(fetchedAt: number | undefined, now: number): boolean {
  return fetchedAt !== undefined && now - fetchedAt < GIT_BRANCHES_STALE_TIME_MS;
}

/**
 * Records that the list published for `key` was read at `fetchedAt`. Called
 * where a read is written to the branch state, so the ledger never vouches for
 * a response that nobody published (its watcher left while it was in flight).
 */
function recordBranchesFetched(key: string, fetchedAt: number): void {
  const now = Date.now();
  // Only fresh entries are ever read; dropping stale ones keeps the ledger to
  // the keys fetched within the last stale window.
  for (const [entryKey, entryFetchedAt] of branchesFetchedAt) {
    if (!isBranchesFetchFresh(entryFetchedAt, now)) branchesFetchedAt.delete(entryKey);
  }
  branchesFetchedAt.set(key, fetchedAt);
}

interface FirstBranchesPageRead {
  readonly page: VcsListRefsResult;
  /**
   * When the read completed, or null when an invalidation or a reset detached
   * it while in flight: it still answers its callers, but is not a fresh read.
   */
  readonly fetchedAt: number | null;
}

/** First page for a key, joining a request that is already in flight. */
function fetchFirstBranchesPage(
  key: string,
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
): Promise<FirstBranchesPageRead> {
  const pending = branchesFirstPageInFlight.get(key);
  if (pending) return pending;
  const promise: Promise<FirstBranchesPageRead> = fetchRefsPage(environmentId, cwd, query, 0).then(
    (page) => {
      const attached = branchesFirstPageInFlight.get(key) === promise;
      if (attached) branchesFirstPageInFlight.delete(key);
      return { page, fetchedAt: attached ? Date.now() : null };
    },
    (error: unknown) => {
      if (branchesFirstPageInFlight.get(key) === promise) branchesFirstPageInFlight.delete(key);
      throw error;
    },
  );
  branchesFirstPageInFlight.set(key, promise);
  return promise;
}

function parseBranchesKey(
  key: string,
): { environmentId: EnvironmentId; cwd: string; query: string } | null {
  const separatorIndex = key.indexOf("\u0000");
  const lastSeparatorIndex = key.lastIndexOf("\u0000");
  if (separatorIndex === -1 || lastSeparatorIndex === separatorIndex) return null;
  return {
    environmentId: key.slice(0, separatorIndex) as EnvironmentId,
    cwd: key.slice(separatorIndex + 1, lastSeparatorIndex),
    query: key.slice(lastSeparatorIndex + 1),
  };
}

/** An invalidated git scope makes every cached list for that cwd stale. */
function markBranchesStaleForScopes(scopes: ReadonlySet<string>): void {
  const affected = (key: string) => {
    const target = parseBranchesKey(key);
    return target !== null && scopes.has(gitScopeKey(target.cwd));
  };
  for (const key of branchesFetchedAt.keys()) {
    if (affected(key)) branchesFetchedAt.delete(key);
  }
  // Later callers must not join a read that started before the change.
  for (const key of branchesFirstPageInFlight.keys()) {
    if (affected(key)) branchesFirstPageInFlight.delete(key);
  }
}

function runBranchesFetch(controller: BranchesController, run: () => Promise<void>): Promise<void> {
  if (controller.inFlightPromise) {
    return controller.inFlightPromise;
  }
  const promise = run().finally(() => {
    if (controller.inFlightPromise === promise) {
      controller.inFlightPromise = null;
    }
  });
  controller.inFlightPromise = promise;
  return promise;
}

async function loadInitialBranchesNow(controller: BranchesController): Promise<void> {
  const token = ++controller.fetchToken;
  const current = appAtomRegistry.get(branchesStateAtom(controller.key));
  setBranchesState(controller.key, {
    pages: current.pages,
    isPending: current.pages.length === 0,
    isFetchingNextPage: false,
    error: null,
  });

  try {
    const { page, fetchedAt } = await fetchFirstBranchesPage(
      controller.key,
      controller.environmentId,
      controller.cwd,
      controller.query,
    );
    if (token !== controller.fetchToken) {
      return;
    }
    controller.loadedPageCount = 1;
    controller.lastFetchedAt = Date.now();
    controller.hasLoadedOnce = true;
    if (fetchedAt !== null) recordBranchesFetched(controller.key, fetchedAt);
    setBranchesState(controller.key, {
      pages: [page],
      isPending: false,
      isFetchingNextPage: false,
      error: null,
    });
  } catch (error) {
    if (token !== controller.fetchToken) {
      return;
    }
    setBranchesState(controller.key, {
      pages: appAtomRegistry.get(branchesStateAtom(controller.key)).pages,
      isPending: false,
      isFetchingNextPage: false,
      error: error instanceof Error ? error : new Error("Failed to load refs."),
    });
  }
}

function loadInitialBranches(controller: BranchesController): Promise<void> {
  return runBranchesFetch(controller, () => loadInitialBranchesNow(controller));
}

async function refetchBranchesNow(controller: BranchesController): Promise<void> {
  const token = ++controller.fetchToken;
  const pageCount = Math.max(1, controller.loadedPageCount);
  const current = appAtomRegistry.get(branchesStateAtom(controller.key));
  setBranchesState(controller.key, {
    pages: current.pages,
    isPending: current.pages.length === 0,
    isFetchingNextPage: false,
    error: null,
  });

  const generation = branchesFetchGeneration;
  try {
    const pages: VcsListRefsResult[] = [];
    let cursor = 0;
    for (let index = 0; index < pageCount; index += 1) {
      const page = await fetchRefsPage(
        controller.environmentId,
        controller.cwd,
        controller.query,
        cursor,
      );
      if (token !== controller.fetchToken) {
        return;
      }
      pages.push(page);
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    controller.loadedPageCount = pages.length;
    controller.lastFetchedAt = Date.now();
    controller.hasLoadedOnce = true;
    if (generation === branchesFetchGeneration) {
      recordBranchesFetched(controller.key, controller.lastFetchedAt);
    }
    setBranchesState(controller.key, {
      pages,
      isPending: false,
      isFetchingNextPage: false,
      error: null,
    });
  } catch (error) {
    if (token !== controller.fetchToken) {
      return;
    }
    setBranchesState(controller.key, {
      pages: appAtomRegistry.get(branchesStateAtom(controller.key)).pages,
      isPending: false,
      isFetchingNextPage: false,
      error: error instanceof Error ? error : new Error("Failed to load refs."),
    });
  }
}

function refetchBranches(controller: BranchesController): Promise<void> {
  return runBranchesFetch(controller, () => refetchBranchesNow(controller));
}

function pollBranches(controller: BranchesController): Promise<void> {
  return controller.hasLoadedOnce ? refetchBranches(controller) : loadInitialBranches(controller);
}

export function fetchNextBranchesPage(targetKey: string | null): void {
  if (targetKey === null) {
    return;
  }
  const controller = branchesControllers.get(targetKey);
  if (!controller) {
    return;
  }
  const state = appAtomRegistry.get(branchesStateAtom(targetKey));
  if (state.isFetchingNextPage || controller.inFlightPromise) {
    return;
  }
  const cursor = nextCursorOf(state.pages);
  if (cursor === null) {
    return;
  }

  setBranchesState(targetKey, { ...state, isFetchingNextPage: true, error: null });
  const token = controller.fetchToken;
  void runBranchesFetch(controller, async () => {
    try {
      const page = await fetchRefsPage(
        controller.environmentId,
        controller.cwd,
        controller.query,
        cursor,
      );
      if (token !== controller.fetchToken) {
        return;
      }
      const latest = appAtomRegistry.get(branchesStateAtom(targetKey));
      controller.loadedPageCount = latest.pages.length + 1;
      controller.lastFetchedAt = Date.now();
      setBranchesState(targetKey, {
        pages: [...latest.pages, page],
        isPending: false,
        isFetchingNextPage: false,
        error: null,
      });
    } catch (error) {
      if (token !== controller.fetchToken) {
        return;
      }
      const latest = appAtomRegistry.get(branchesStateAtom(targetKey));
      setBranchesState(targetKey, {
        ...latest,
        isFetchingNextPage: false,
        error: error instanceof Error ? error : new Error("Failed to load refs."),
      });
    }
  });
}

export function refreshBranches(targetKey: string | null): void {
  if (targetKey === null) {
    return;
  }
  const controller = branchesControllers.get(targetKey);
  if (!controller) {
    // Warm the cache even when no component is currently subscribed.
    void prefetchBranchesByKey(targetKey);
    return;
  }
  void (controller.poller?.refresh() ?? pollBranches(controller));
}

function maybeRefetchStaleBranches(controller: BranchesController): void {
  if (Date.now() - controller.lastFetchedAt < GIT_BRANCHES_STALE_TIME_MS) {
    return;
  }
  void (controller.poller?.refresh() ?? pollBranches(controller));
}

export function watchBranches(target: BranchesTarget): () => void {
  if (target.environmentId === null || target.cwd === null) {
    return NOOP;
  }

  const environmentId = target.environmentId;
  const cwd = target.cwd;
  const key = branchesKey({ environmentId, cwd, query: target.query });

  const existing = branchesControllers.get(key);
  if (existing) {
    existing.subscriberCount += 1;
    if (existing.hasLoadedOnce) {
      maybeRefetchStaleBranches(existing);
    }
    return () => unwatchBranches(key);
  }

  // A list loaded within the stale time (by a previous subscriber or a
  // prefetch) is adopted as is; the poller then waits a full interval.
  const cachedState = appAtomRegistry.get(branchesStateAtom(key));
  const cachedPages = cachedState.pages;
  const fetchedAt = branchesFetchedAt.get(key);
  const adoptCached = cachedPages.length > 0 && isBranchesFetchFresh(fetchedAt, Date.now());
  if (adoptCached && cachedState.isFetchingNextPage) {
    // A next page the previous watcher had in flight was dropped with it;
    // left set, the flag would block pagination until the next refetch.
    setBranchesState(key, { ...cachedState, isFetchingNextPage: false });
  }

  const controller: BranchesController = {
    key,
    environmentId,
    cwd,
    query: target.query,
    subscriberCount: 1,
    loadedPageCount: adoptCached ? cachedPages.length : 0,
    lastFetchedAt: adoptCached ? (fetchedAt ?? 0) : 0,
    fetchToken: 0,
    hasLoadedOnce: adoptCached,
    inFlightPromise: null,
    invalidationUnsub: NOOP,
    focusListener: null,
    poller: null,
  };
  branchesControllers.set(key, controller);

  controller.invalidationUnsub = subscribeInvalidationScope(gitScopeKey(cwd), () => {
    void (controller.poller?.refresh() ?? pollBranches(controller));
  });

  if (typeof window !== "undefined") {
    const focusListener = () => maybeRefetchStaleBranches(controller);
    controller.focusListener = focusListener;
    window.addEventListener("focus", focusListener);
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    controller.poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: () => pollBranches(controller),
      resolveDelayMs: () => GIT_BRANCHES_REFETCH_INTERVAL_MS,
      runImmediately: !adoptCached,
      jitterRatio: 0.05,
    });
  } else if (!adoptCached) {
    void loadInitialBranches(controller);
  }

  return () => unwatchBranches(key);
}

function unwatchBranches(key: string): void {
  const controller = branchesControllers.get(key);
  if (!controller) {
    return;
  }
  controller.subscriberCount -= 1;
  if (controller.subscriberCount > 0) {
    return;
  }

  controller.invalidationUnsub();
  if (controller.focusListener && typeof window !== "undefined") {
    window.removeEventListener("focus", controller.focusListener);
  }
  controller.poller?.stop();
  controller.fetchToken += 1;
  branchesControllers.delete(key);
}

async function prefetchBranchesByKey(targetKey: string): Promise<void> {
  if (branchesFirstPageInFlight.has(targetKey)) {
    return;
  }
  const controller = branchesControllers.get(targetKey);
  if (controller) {
    // An active subscriber owns the fetch lifecycle already.
    return;
  }
  const target = parseBranchesKey(targetKey);
  if (target === null) {
    return;
  }

  const generation = branchesFetchGeneration;
  try {
    // A controller created while this is in flight joins the same request
    // and publishes its result itself.
    const { page, fetchedAt } = await fetchFirstBranchesPage(
      targetKey,
      target.environmentId,
      target.cwd,
      target.query,
    );
    if (generation !== branchesFetchGeneration || branchesControllers.has(targetKey)) {
      return;
    }
    if (fetchedAt !== null) recordBranchesFetched(targetKey, fetchedAt);
    setBranchesState(targetKey, {
      pages: [page],
      isPending: false,
      isFetchingNextPage: false,
      error: null,
    });
  } catch {
    // Prefetch failures are non-fatal; the next subscription will retry.
  }
}

export function prefetchBranches(target: BranchesTarget): void {
  const key = getBranchesTargetKey(target);
  if (key === null) {
    return;
  }
  const snapshot = appAtomRegistry.get(branchesStateAtom(key));
  if (snapshot.pages.length > 0) {
    return;
  }
  void prefetchBranchesByKey(key);
}

export function flattenBranchRefs(pages: ReadonlyArray<VcsListRefsResult>): ReadonlyArray<VcsRef> {
  return pages.flatMap((page) => page.refs);
}

// ---------------------------------------------------------------------------
// Pull request resolution
//
// Replaces `gitResolvePullRequestQueryOptions` + `useQuery`.
// ---------------------------------------------------------------------------

const RESOLVE_PULL_REQUEST_STALE_TIME_MS = 30_000;

export interface ResolvePullRequestState {
  readonly data: GitResolvePullRequestResult | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}

const EMPTY_RESOLVE_PR_STATE: ResolvePullRequestState = Object.freeze({
  data: null,
  isPending: false,
  isFetching: false,
  isError: false,
  error: null,
});

export const EMPTY_RESOLVE_PR_ATOM = Atom.make(EMPTY_RESOLVE_PR_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-resolve-pr:null"),
);

const knownResolvePrKeys = new Set<string>();

const resolvePrStateAtom = Atom.family((key: string) => {
  knownResolvePrKeys.add(key);
  return Atom.make(EMPTY_RESOLVE_PR_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-resolve-pr:${key}`),
  );
});

interface ResolvePullRequestTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

interface ResolvePrController {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly reference: string;
  subscriberCount: number;
  lastFetchedAt: number;
  fetchToken: number;
}

const resolvePrControllers = new Map<string, ResolvePrController>();

function resolvePrKey(target: {
  environmentId: EnvironmentId;
  cwd: string;
  reference: string;
}): string {
  return `${target.environmentId}\u0000${target.cwd}\u0000${target.reference}`;
}

export function getResolvePullRequestTargetKey(target: ResolvePullRequestTarget): string | null {
  if (target.environmentId === null || target.cwd === null || target.reference === null) {
    return null;
  }
  return resolvePrKey({
    environmentId: target.environmentId,
    cwd: target.cwd,
    reference: target.reference,
  });
}

export function getResolvePullRequestAtom(
  targetKey: string | null,
): Atom.Atom<ResolvePullRequestState> {
  return targetKey === null ? EMPTY_RESOLVE_PR_ATOM : resolvePrStateAtom(targetKey);
}

export function getResolvePullRequestSnapshot(targetKey: string | null): ResolvePullRequestState {
  if (targetKey === null) {
    return EMPTY_RESOLVE_PR_STATE;
  }
  return appAtomRegistry.get(resolvePrStateAtom(targetKey));
}

async function loadResolvePullRequest(controller: ResolvePrController): Promise<void> {
  const token = ++controller.fetchToken;
  const current = appAtomRegistry.get(resolvePrStateAtom(controller.key));
  appAtomRegistry.set(resolvePrStateAtom(controller.key), {
    data: current.data,
    isPending: current.data === null,
    isFetching: true,
    isError: false,
    error: null,
  });

  try {
    const api = readEnvironmentApi(controller.environmentId);
    if (!api) {
      throw new Error("Pull request lookup is unavailable.");
    }
    const result = await api.git.resolvePullRequest({
      cwd: controller.cwd,
      reference: controller.reference,
    });
    if (token !== controller.fetchToken) {
      return;
    }
    controller.lastFetchedAt = Date.now();
    appAtomRegistry.set(resolvePrStateAtom(controller.key), {
      data: result,
      isPending: false,
      isFetching: false,
      isError: false,
      error: null,
    });
  } catch (error) {
    if (token !== controller.fetchToken) {
      return;
    }
    appAtomRegistry.set(resolvePrStateAtom(controller.key), {
      data: null,
      isPending: false,
      isFetching: false,
      isError: true,
      error: error instanceof Error ? error : new Error("Failed to resolve pull request."),
    });
  }
}

export function watchResolvePullRequest(target: ResolvePullRequestTarget): () => void {
  const key = getResolvePullRequestTargetKey(target);
  if (
    key === null ||
    target.environmentId === null ||
    target.cwd === null ||
    target.reference === null
  ) {
    return NOOP;
  }

  const environmentId = target.environmentId;
  const cwd = target.cwd;
  const reference = target.reference;

  const existing = resolvePrControllers.get(key);
  if (existing) {
    existing.subscriberCount += 1;
    if (Date.now() - existing.lastFetchedAt >= RESOLVE_PULL_REQUEST_STALE_TIME_MS) {
      void loadResolvePullRequest(existing);
    }
    return () => unwatchResolvePullRequest(key);
  }

  const controller: ResolvePrController = {
    key,
    environmentId,
    cwd,
    reference,
    subscriberCount: 1,
    lastFetchedAt: 0,
    fetchToken: 0,
  };
  resolvePrControllers.set(key, controller);
  void loadResolvePullRequest(controller);

  return () => unwatchResolvePullRequest(key);
}

function unwatchResolvePullRequest(key: string): void {
  const controller = resolvePrControllers.get(key);
  if (!controller) {
    return;
  }
  controller.subscriberCount -= 1;
  if (controller.subscriberCount > 0) {
    return;
  }
  controller.fetchToken += 1;
  resolvePrControllers.delete(key);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function clearGitAtomState(): void {
  for (const controller of branchesControllers.values()) {
    controller.fetchToken += 1;
    controller.invalidationUnsub();
    if (controller.focusListener && typeof window !== "undefined") {
      window.removeEventListener("focus", controller.focusListener);
    }
    controller.poller?.stop();
  }
  branchesControllers.clear();
  branchesFetchGeneration += 1;
  branchesFirstPageInFlight.clear();
  branchesFetchedAt.clear();
  for (const controller of resolvePrControllers.values()) {
    controller.fetchToken += 1;
  }
  resolvePrControllers.clear();
  invalidationListeners.clear();

  // Atom.family retains each atom instance. Keep the matching key indexes too,
  // so a later clear can reset a key that was reused after an earlier clear.
  for (const key of knownBranchesKeys) {
    appAtomRegistry.set(branchesStateAtom(key), INITIAL_BRANCHES_STATE);
  }
  for (const key of knownResolvePrKeys) {
    appAtomRegistry.set(resolvePrStateAtom(key), EMPTY_RESOLVE_PR_STATE);
  }
  for (const key of knownMutationTrackingKeys) {
    appAtomRegistry.set(mutationRunningCountAtom(key), 0);
  }
}

export const resetGitAtomsForTests = clearGitAtomState;
