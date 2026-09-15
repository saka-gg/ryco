import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadFileResult,
} from "@ryco/contracts";

import { ensureEnvironmentApi } from "~/environmentApi";
import {
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
} from "@ryco/client-runtime/rpc";

const LIST_ENTRIES_STALE_TIME_MS = 0;
const READ_FILE_STALE_TIME_MS = 0;
const FETCH_RETRY_COUNT = 1;
const PROJECT_PREVIEW_GC_TIME_MS = 60_000;

export interface ProjectPreviewQueryState<T> {
  readonly data: T | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: Error | null;
}

const INITIAL_QUERY_STATE: ProjectPreviewQueryState<never> = Object.freeze({
  data: null,
  isLoading: false,
  isFetching: false,
  error: null,
});

const projectPreviewRegistry = createKeyedQueryRegistry<ProjectPreviewQueryState<unknown>>({
  labelPrefix: "project-preview",
  initialState: INITIAL_QUERY_STATE,
  gcTime: PROJECT_PREVIEW_GC_TIME_MS,
  maxEntries: 48,
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
  isErrorState: (state) => state.error !== null,
});

export type ProjectPreviewQuery<TInput, TData> = KeyedQueryByKey<
  TInput,
  TData,
  ProjectPreviewQueryState<TData>
>;

interface ProjectPreviewQueryDefinition<TInput, TData> {
  readonly label: string;
  readonly staleTime: number;
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

function defineQuery<TInput, TData>(
  definition: ProjectPreviewQueryDefinition<TInput, TData>,
): ProjectPreviewQuery<TInput, TData> {
  return defineKeyedQueryByKey(
    projectPreviewRegistry,
    {
      ...definition,
      createControllerFields: () => ({}),
    },
    (controller) =>
      !controller.hasData || Date.now() - controller.lastFetchedAt >= controller.staleTime,
  ) as ProjectPreviewQuery<TInput, TData>;
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

/** Keep the selected-file cache aligned with an explicit read or save. */
export function setProjectReadFileCacheData(
  input: ProjectReadFileInput,
  data: ProjectReadFileResult,
): void {
  const cacheKey = projectReadFileQuery.keyOf(input);
  if (cacheKey === null) return;
  const controller = projectPreviewRegistry.controllers.get(cacheKey);
  if (controller) {
    projectPreviewRegistry.cancel(controller);
    controller.hasData = true;
    controller.lastFetchedAt = Date.now();
  }
  projectPreviewRegistry.setQueryState(cacheKey, {
    data,
    isLoading: false,
    isFetching: false,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetProjectPreviewAtomsForTests(): void {
  projectPreviewRegistry.resetForTests();
}
