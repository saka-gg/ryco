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
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import {
  normalizeWorkspaceFileSearchQuery,
  WORKSPACE_FILE_SEARCH_LIMIT,
} from "@ryco/client-runtime/state/files";

import { cachedPayloadBytes } from "../persistence/cacheSize";
import { ensureEnvironmentApi } from "../connection/environmentApi";
import {
  createMobileQueryCache,
  runWithRetry,
  type MobileQuery,
  type MobileQueryState,
} from "./mobileQueryCache";

// Listings and search results tolerate a short window of staleness (the provider
// invalidation flush and pull-to-refresh cover real changes); file contents do
// not, so a remount always re-reads the file it is about to render.
const LIST_ENTRIES_STALE_TIME_MS = 15_000;
const READ_FILE_STALE_TIME_MS = 0;
const SEARCH_ENTRIES_STALE_TIME_MS = 15_000;

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

export type ProjectFilesQueryState<T> = MobileQueryState<T>;

export type ProjectFilesQuery<TInput, TData> = MobileQuery<TInput, TData>;

const projectFilesCache = createMobileQueryCache("project-files");
const defineQuery = projectFilesCache.defineQuery;

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
  projectFilesCache.invalidate();
}

/** Environment teardown: forget everything this cache holds for one node. */
export function clearProjectFilesStateForEnvironment(environmentId: EnvironmentId): void {
  projectFilesCache.clearEnvironment(environmentId);
}

/** Retained file/listing payloads, split from raster previews for Storage settings. */
export function projectFilesCacheStats(environmentId: EnvironmentId): {
  files: number;
  images: number;
} {
  let files = 0,
    images = 0;
  for (const [label, data] of projectFilesCache.unobservedEntries(environmentId)) {
    const bytes = cachedPayloadBytes(data);
    if (label === "readFileBinary") images += bytes;
    else files += bytes;
  }
  return { files, images };
}

/** Cache-only eviction: does not invoke the registry-wide environment teardown. */
export function clearProjectFileCache(environmentId: EnvironmentId): void {
  projectFilesCache.clearUnobserved(environmentId);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetProjectFilesAtomsForTests(): void {
  projectFilesCache.resetForTests();
}
