// Workspace file-browser cache: the mobile port of
// apps/web/src/rpc/projectPreviewAtoms.ts over the shared keyed-query layer
// (defineKeyedQueryByKey), plus the server-side entry search the browser's
// search row drives. Only the environmentApi import path differs from web;
// requests resolve `ensureEnvironmentApi` inside `run` (never at module load) so
// the documented cycle driver -> cache -> environmentApi -> bootstrap -> driver
// stays load-safe.
//
// Read-only by construction: nothing here reaches projects.writeFile or
// stageFileReference. Node-owned listings and file contents live only in the
// atom state — never persisted, never logged — and are dropped when the
// environment is torn down or the retained-key budget is exceeded.
import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadFileBinaryResult,
  ProjectReadFileResult,
  ProjectSearchEntriesResult,
} from "@ryco/contracts";
import {
  clearKeyedQueriesForEnvironment,
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
} from "@ryco/client-runtime/rpc";
import {
  normalizeWorkspaceFileSearchQuery,
  WORKSPACE_FILE_SEARCH_LIMIT,
} from "@ryco/client-runtime/state/files";

import { cachedPayloadBytes } from "../persistence/cacheSize";
import { ensureEnvironmentApi } from "../connection/environmentApi";

// Listings and search results tolerate a short window of staleness (the provider
// invalidation flush and pull-to-refresh cover real changes); file contents do
// not, so a remount always re-reads the file it is about to render.
const LIST_ENTRIES_STALE_TIME_MS = 15_000;
const READ_FILE_STALE_TIME_MS = 0;
const SEARCH_ENTRIES_STALE_TIME_MS = 15_000;
const FETCH_RETRY_COUNT = 1;

// Boundedness: a phone browsing a large workspace would otherwise retain every
// directory it ever expanded and every file it ever opened. Once a key has no
// observers it becomes evictable, and each family keeps only its most recently
// released keys — enough to make back-navigation instant without holding node
// content for a session's worth of browsing.
export const PROJECT_LIST_ENTRIES_RETAINED_KEY_LIMIT = 8;
export const PROJECT_READ_FILE_RETAINED_KEY_LIMIT = 24;
export const PROJECT_SEARCH_ENTRIES_RETAINED_KEY_LIMIT = 30;
/**
 * Far tighter than the text budget: one retained entry here is a base64 raster
 * image, up to ~5.4 MB of string on a device whose whole JS heap is a few
 * hundred, so the browser remembers only the handful of images just looked at.
 */
export const PROJECT_READ_FILE_BINARY_RETAINED_KEY_LIMIT = 6;

export interface ProjectFilesQueryState<T> {
  readonly data: T | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

const INITIAL_QUERY_STATE: ProjectFilesQueryState<never> = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  error: null,
});

const projectFilesRegistry = createKeyedQueryRegistry<ProjectFilesQueryState<unknown>>({
  labelPrefix: "project-files",
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

export type ProjectFilesQuery<TInput, TData> = KeyedQueryByKey<
  TInput,
  TData,
  ProjectFilesQueryState<TData>
>;

interface ProjectFilesQueryDefinition<TInput, TData> {
  readonly label: string;
  readonly staleTime: number;
  readonly retainedKeyLimit: number;
  readonly isEnabled: (input: TInput) => boolean;
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly run: (input: TInput) => Promise<TData>;
}

function runWithRetry<T>(run: () => Promise<T>, retries = FETCH_RETRY_COUNT): Promise<T> {
  return run().catch((error) => {
    if (retries <= 0) {
      throw error;
    }
    return runWithRetry(run, retries - 1);
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

/**
 * Forget one cache key completely: the controller is dropped, its in-flight
 * response is fenced by the token bump (runController discards a result whose
 * token moved), and the state atom falls back to the initial state so a later
 * read cannot observe evicted node content.
 */
function dropCachedKey(compositeKey: string): void {
  const controller = projectFilesRegistry.controllers.get(compositeKey);
  if (controller) {
    projectFilesRegistry.clearPollTimer(controller);
    controller.fetchToken += 1;
    projectFilesRegistry.controllers.delete(compositeKey);
  }
  projectFilesRegistry.setQueryState(compositeKey, projectFilesRegistry.initialState);
  projectFilesRegistry.knownStateKeys.delete(compositeKey);
  trackedKeys.delete(compositeKey);
}

interface RetainedKeyTracker {
  /** The key gained an observer again, so it is no longer evictable. */
  readonly retain: (compositeKey: string) => void;
  /** The key lost its last observer: evictable, most recently released last. */
  readonly release: (compositeKey: string) => void;
  readonly forgetEnvironment: (environmentId: EnvironmentId) => void;
  readonly clear: () => void;
}

const retainedKeyTrackers: RetainedKeyTracker[] = [];

function createRetainedKeyTracker(label: string, limit: number): RetainedKeyTracker {
  // Insertion-ordered by release time: the first entry is the least recently
  // released key, so eviction walks from the front.
  const released = new Set<string>();

  function evict(): void {
    for (const compositeKey of released) {
      if (released.size <= limit) return;
      released.delete(compositeKey);
      dropCachedKey(compositeKey);
    }
  }

  const tracker: RetainedKeyTracker = {
    retain: (compositeKey) => {
      released.delete(compositeKey);
    },
    release: (compositeKey) => {
      released.delete(compositeKey);
      released.add(compositeKey);
      evict();
    },
    forgetEnvironment: (environmentId) => {
      const prefix = `${label}${KEY_SEP}${environmentId}${KEY_SEP}`;
      for (const compositeKey of released) {
        if (compositeKey.startsWith(prefix)) released.delete(compositeKey);
      }
    },
    clear: () => {
      released.clear();
    },
  };
  retainedKeyTrackers.push(tracker);
  return tracker;
}

function defineQuery<TInput, TData>(
  definition: ProjectFilesQueryDefinition<TInput, TData>,
): ProjectFilesQuery<TInput, TData> {
  const query = defineKeyedQueryByKey(
    projectFilesRegistry,
    {
      ...definition,
      createControllerFields: () => ({}),
    },
    (controller) =>
      !controller.hasData || Date.now() - controller.lastFetchedAt >= controller.staleTime,
  ) as ProjectFilesQuery<TInput, TData>;

  const tracker = createRetainedKeyTracker(definition.label, definition.retainedKeyLimit);

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
      const controller = projectFilesRegistry.controllers.get(compositeKey);
      if (!controller || controller.subscriberCount > 0) return;
      tracker.release(compositeKey);
    };
  }

  return { ...query, watch };
}

function projectsClient(environmentId: EnvironmentId) {
  return ensureEnvironmentApi(environmentId).projects;
}

// ---------------------------------------------------------------------------
// List entries (workspace tree)
// ---------------------------------------------------------------------------

export interface ProjectListEntriesInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly enabled?: boolean;
}

export const projectListEntriesQuery = defineQuery<
  ProjectListEntriesInput,
  ProjectListEntriesResult
>({
  label: "listEntries",
  staleTime: LIST_ENTRIES_STALE_TIME_MS,
  retainedKeyLimit: PROJECT_LIST_ENTRIES_RETAINED_KEY_LIMIT,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.cwd}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      projectsClient(input.environmentId as EnvironmentId).listEntries({
        cwd: input.cwd as string,
      }),
    ),
});

// ---------------------------------------------------------------------------
// Read file (preview content)
// ---------------------------------------------------------------------------

export interface ProjectReadFileInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly enabled?: boolean;
}

export const projectReadFileQuery = defineQuery<ProjectReadFileInput, ProjectReadFileResult>({
  label: "readFile",
  staleTime: READ_FILE_STALE_TIME_MS,
  retainedKeyLimit: PROJECT_READ_FILE_RETAINED_KEY_LIMIT,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.relativePath !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.relativePath}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      projectsClient(input.environmentId as EnvironmentId).readFile({
        cwd: input.cwd as string,
        relativePath: input.relativePath as string,
      }),
    ),
});

// ---------------------------------------------------------------------------
// Read file binary (raster image preview)
// ---------------------------------------------------------------------------
//
// Only the raster image kind routes here. The node caps the raw file at 4 MiB
// and derives the mime type from the magic bytes, so what comes back is either
// image bytes it vouched for or a refusal the screen classifies — the client
// never guesses a type from the extension, and never builds a node URL to fetch
// the file over HTTP.

export interface ProjectReadFileBinaryInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly enabled?: boolean;
}

export const projectReadFileBinaryQuery = defineQuery<
  ProjectReadFileBinaryInput,
  ProjectReadFileBinaryResult
>({
  label: "readFileBinary",
  staleTime: READ_FILE_STALE_TIME_MS,
  retainedKeyLimit: PROJECT_READ_FILE_BINARY_RETAINED_KEY_LIMIT,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.relativePath !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.relativePath}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      projectsClient(input.environmentId as EnvironmentId).readFileBinary({
        cwd: input.cwd as string,
        relativePath: input.relativePath as string,
      }),
    ),
});

// ---------------------------------------------------------------------------
// Search entries (server-side ranking)
// ---------------------------------------------------------------------------
//
// The query shape (trim, 256-char cap, "" means "not a request") and the request
// limit come from @ryco/client-runtime/state/files so the screens, the cache key
// and the outgoing request cannot disagree about what a search is.

export interface ProjectSearchEntriesInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
  readonly limit?: number;
  readonly enabled?: boolean;
}

/** The contracts schema rejects limits above 200; clamp rather than bounce. */
const PROJECT_SEARCH_ENTRIES_CONTRACT_MAX_LIMIT = 200;

function searchEntriesLimit(input: ProjectSearchEntriesInput): number {
  return Math.min(
    input.limit ?? WORKSPACE_FILE_SEARCH_LIMIT,
    PROJECT_SEARCH_ENTRIES_CONTRACT_MAX_LIMIT,
  );
}

export const projectSearchEntriesQuery = defineQuery<
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult
>({
  label: "searchEntries",
  staleTime: SEARCH_ENTRIES_STALE_TIME_MS,
  retainedKeyLimit: PROJECT_SEARCH_ENTRIES_RETAINED_KEY_LIMIT,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    normalizeWorkspaceFileSearchQuery(input.query).length > 0,
  // The query is part of the key: every distinct search is its own cache entry
  // under the same workspace scope, so backspacing to a previous query answers
  // from cache instead of re-asking the node.
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}search${KEY_SEP}${searchEntriesLimit(
      input,
    )}${KEY_SEP}${normalizeWorkspaceFileSearchQuery(input.query)}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      projectsClient(input.environmentId as EnvironmentId).searchEntries({
        cwd: input.cwd as string,
        query: normalizeWorkspaceFileSearchQuery(input.query),
        limit: searchEntriesLimit(input),
      }),
    ),
});

// ---------------------------------------------------------------------------
// Invalidation + teardown
// ---------------------------------------------------------------------------

/**
 * Provider-invalidation flush: workspace files are node-owned state, so a push
 * that changed the workspace makes every cached listing, read and search stale.
 * Observed queries refetch in the background (previous data stays visible);
 * idle ones are marked stale and fenced, so a later watch refetches instead of
 * publishing a response the invalidation already raced.
 */
export function invalidateProjectFilesState(): void {
  for (const controller of projectFilesRegistry.controllers.values()) {
    controller.lastFetchedAt = 0;
    // Fence any response already in flight before asking an observed query
    // for fresh node-owned state. The registry otherwise joins duplicate
    // callers, which would let the invalidation wait on the stale request.
    projectFilesRegistry.cancel(controller);
    if (controller.subscriberCount > 0) {
      void projectFilesRegistry.runController(controller);
    }
  }
}

/**
 * Environment teardown: forget everything this cache holds for one node.
 *
 * The registry-global helper runs first — this is the single mobile teardown
 * site, so a keyed-query cache added later is covered without another
 * registration. It is not sufficient on its own: its state sweep matches keys
 * that START with the environment id while a `defineKeyedQueryByKey` composite
 * key is label-first, and it can only see the keys the registry still tracks.
 * The second pass is the authoritative one for this cache.
 */
export function clearProjectFilesStateForEnvironment(environmentId: EnvironmentId): void {
  clearKeyedQueriesForEnvironment(environmentId);
  // `dropCachedKey` only removes the key being visited, which Set iteration
  // tolerates.
  for (const compositeKey of trackedKeys) {
    if (compositeKey.split(KEY_SEP)[1] !== environmentId) continue;
    dropCachedKey(compositeKey);
  }
  for (const tracker of retainedKeyTrackers) tracker.forgetEnvironment(environmentId);
}

/** Retained file/listing payloads, split from raster previews for Storage settings. */
export function projectFilesCacheStats(environmentId: EnvironmentId): {
  files: number;
  images: number;
} {
  let files = 0,
    images = 0;
  for (const key of trackedKeys) {
    const [label, environment] = key.split(KEY_SEP);
    if (environment !== environmentId) continue;
    if ((projectFilesRegistry.controllers.get(key)?.subscriberCount ?? 0) > 0) continue;
    const bytes = cachedPayloadBytes(projectFilesRegistry.getQueryState(key).data);
    if (label === "readFileBinary") images += bytes;
    else files += bytes;
  }
  return { files, images };
}

/** Cache-only eviction: does not invoke the registry-wide environment teardown. */
export function clearProjectFileCache(environmentId: EnvironmentId): void {
  for (const key of trackedKeys) {
    if (
      key.split(KEY_SEP)[1] === environmentId &&
      (projectFilesRegistry.controllers.get(key)?.subscriberCount ?? 0) === 0
    )
      dropCachedKey(key);
  }
  for (const tracker of retainedKeyTrackers) tracker.forgetEnvironment(environmentId);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetProjectFilesAtomsForTests(): void {
  projectFilesRegistry.resetForTests();
  for (const compositeKey of trackedKeys) dropCachedKey(compositeKey);
  for (const tracker of retainedKeyTrackers) tracker.clear();
}
