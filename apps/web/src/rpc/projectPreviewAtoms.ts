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
import { listEntriesSince, readFileSince } from "@ryco/client-runtime/state/files";

import { onCheckoutFilesChanged } from "./workspaceChangeInvalidation";

// Like the phone: a turn that changed files invalidates its checkout's tree
// (the runtime's workspace change flush), and a re-read the node answers
// `unchanged` costs about a hundred bytes, so a reopen within this window
// reads nothing at all.
const LIST_ENTRIES_STALE_TIME_MS = 15_000;
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

export const projectListEntriesQuery: ProjectPreviewQuery<
  ProjectListEntriesInput,
  ProjectListEntriesResult
> = defineQuery<ProjectListEntriesInput, ProjectListEntriesResult>({
  label: "listEntries",
  staleTime: LIST_ENTRIES_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) => `${input.environmentId}${KEY_SEP}${input.cwd}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      listEntriesSince(
        projectsClient(input.environmentId as EnvironmentId).listEntries,
        input.cwd as string,
        projectListEntriesQuery.getSnapshot(projectListEntriesQuery.keyOf(input)).data,
      ),
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

export const projectReadFileQuery: ProjectPreviewQuery<
  ProjectReadFileInput,
  ProjectReadFileResult
> = defineQuery<ProjectReadFileInput, ProjectReadFileResult>({
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
      readFileSince(
        projectsClient(input.environmentId as EnvironmentId).readFile,
        { cwd: input.cwd as string, relativePath: input.relativePath as string },
        projectReadFileQuery.getSnapshot(projectReadFileQuery.keyOf(input)).data,
      ),
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

/**
 * Read the file again now, dropping a read already in flight: that read may
 * have started before the change on disk this one is for.
 */
export async function refetchProjectReadFileFresh(cacheKey: string | null): Promise<void> {
  if (cacheKey === null) return;
  const controller = projectPreviewRegistry.controllers.get(cacheKey);
  if (controller) projectPreviewRegistry.cancel(controller);
  await projectReadFileQuery.refreshAsync(cacheKey);
}

/**
 * A turn changed files in one checkout (`cwd` null: every checkout of the
 * environment): its tree and file reads are stale. Observed ones read again in
 * the background, sending what they hold, so an unchanged answer is tiny.
 */
export function invalidateProjectPreviewCheckout(
  environmentId: EnvironmentId,
  cwd: string | null,
): void {
  for (const compositeKey of projectPreviewRegistry.controllerKeys({ environmentId })) {
    const controller = projectPreviewRegistry.controllers.get(compositeKey);
    if (!controller) continue;
    if (cwd !== null && compositeKey.split(KEY_SEP)[2] !== cwd) continue;
    controller.lastFetchedAt = 0;
    projectPreviewRegistry.cancel(controller);
    if (controller.subscriberCount > 0) void projectPreviewRegistry.runController(controller);
  }
}

onCheckoutFilesChanged(invalidateProjectPreviewCheckout);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetProjectPreviewAtomsForTests(): void {
  projectPreviewRegistry.resetForTests();
}
