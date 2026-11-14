import type {
  AtlassianConnectionId,
  EnvironmentId,
  ProjectId,
  WorkItemDetail as WorkItemDetailModel,
  WorkItemProject,
  WorkItemStateFilter,
  WorkItemSummary,
} from "@ryco/contracts";

import { requireEnvironmentConnection } from "~/environments/runtime";
import { createKeyedQueryRegistry, defineKeyedQueryByKey, KEY_SEP } from "@ryco/client-runtime/rpc";

import {
  isPastStaleTime,
  KEYED_QUERY_STATE_BUILDERS,
  type KeyedQueryState,
} from "./keyedQueryState";

// ---------------------------------------------------------------------------
// Atom-backed work-item reads.
//
// Replaces the React Query `workItem*QueryOptions` helpers in
// `~/lib/workItemsRpc` (project discovery, list, search, detail). List/search/
// detail/project reads are reactive (`watch` + state atoms) and scoped by
// environment + project for invalidation, matching the previous
// `queryClient.invalidateQueries({ queryKey: workItemsQueryKeys.all })`.
// ---------------------------------------------------------------------------

const LIST_STALE_TIME_MS = 60_000;
const SEARCH_STALE_TIME_MS = 30_000;
const DETAIL_STALE_TIME_MS = 60_000;
const PROJECTS_STALE_TIME_MS = 5 * 60_000;

export type WorkItemQueryState<T> = KeyedQueryState<T>;

const workItemsRegistry = createKeyedQueryRegistry<WorkItemQueryState<unknown>>({
  labelPrefix: "work-items",
  ...KEYED_QUERY_STATE_BUILDERS,
});

const { controllers, setQueryState, runController } = workItemsRegistry;

export type WorkItemQuery<TInput, TData> = import("@ryco/client-runtime/rpc").KeyedQueryByKey<
  TInput,
  TData,
  WorkItemQueryState<TData>
>;

interface WorkItemQueryDefinition<TInput, TData> {
  readonly label: string;
  readonly staleTime: number;
  readonly isEnabled: (input: TInput) => boolean;
  readonly buildKey: (input: TInput) => string;
  readonly resolveEnvironmentId: (input: TInput) => EnvironmentId;
  readonly resolveProjectId: (input: TInput) => ProjectId | null;
  readonly run: (input: TInput) => Promise<TData>;
}

function defineQuery<TInput, TData>(
  definition: WorkItemQueryDefinition<TInput, TData>,
): WorkItemQuery<TInput, TData> {
  return defineKeyedQueryByKey(
    workItemsRegistry,
    {
      ...definition,
      createControllerFields: (input) => ({ projectId: definition.resolveProjectId(input) }),
    },
    isPastStaleTime,
  ) as WorkItemQuery<TInput, TData>;
}

function workItemsClient(environmentId: EnvironmentId) {
  return requireEnvironmentConnection(environmentId).client.workItems;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

export interface WorkItemProjectsInput {
  readonly environmentId: EnvironmentId | null;
  readonly connectionId: AtlassianConnectionId | null;
  readonly siteUrl?: string;
  readonly enabled?: boolean;
}

export const workItemProjectsQuery = defineQuery<
  WorkItemProjectsInput,
  ReadonlyArray<WorkItemProject>
>({
  label: "projects",
  staleTime: PROJECTS_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.connectionId !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.connectionId}${KEY_SEP}${input.siteUrl?.trim() ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveProjectId: () => null,
  run: (input) => {
    const siteUrl = input.siteUrl?.trim() ?? "";
    return workItemsClient(input.environmentId as EnvironmentId).listProjects({
      connectionId: input.connectionId as AtlassianConnectionId,
      ...(siteUrl.length > 0 ? { siteUrl } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface WorkItemListInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly state: WorkItemStateFilter;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const workItemListQuery = defineQuery<WorkItemListInput, ReadonlyArray<WorkItemSummary>>({
  label: "list",
  staleTime: LIST_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.projectId}${KEY_SEP}${input.state}${KEY_SEP}${input.limit ?? ""}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveProjectId: (input) => input.projectId,
  run: (input) =>
    workItemsClient(input.environmentId as EnvironmentId).list({
      projectId: input.projectId as ProjectId,
      state: input.state,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface WorkItemSearchInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly query: string;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export const workItemSearchQuery = defineQuery<WorkItemSearchInput, ReadonlyArray<WorkItemSummary>>(
  {
    label: "search",
    staleTime: SEARCH_STALE_TIME_MS,
    isEnabled: (input) =>
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.projectId !== null &&
      input.query.trim().length > 0,
    buildKey: (input) =>
      `${input.environmentId}${KEY_SEP}${input.projectId}${KEY_SEP}${input.query.trim()}${KEY_SEP}${input.limit ?? ""}`,
    resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
    resolveProjectId: (input) => input.projectId,
    run: (input) =>
      workItemsClient(input.environmentId as EnvironmentId).search({
        projectId: input.projectId as ProjectId,
        query: input.query.trim(),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
  },
);

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface WorkItemDetailInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly key: string;
  readonly fullContent?: boolean;
  readonly enabled?: boolean;
}

export const workItemDetailQuery = defineQuery<WorkItemDetailInput, WorkItemDetailModel>({
  label: "detail",
  staleTime: DETAIL_STALE_TIME_MS,
  isEnabled: (input) =>
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.projectId !== null &&
    input.key.trim().length > 0,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.projectId}${KEY_SEP}${input.key}${KEY_SEP}${input.fullContent ?? false}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  resolveProjectId: (input) => input.projectId,
  run: (input) =>
    workItemsClient(input.environmentId as EnvironmentId).get({
      projectId: input.projectId as ProjectId,
      key: input.key,
      fullContent: input.fullContent ?? false,
    }),
});

/**
 * Imperatively seed the cached detail for a work item (both truncated and
 * full-content variants), mirroring the former
 * `queryClient.setQueryData(workItemsQueryKeys.detail(...))` after comment and
 * field mutations.
 */
export function setWorkItemDetailCache(
  scope: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  key: string,
  detail: WorkItemDetailModel,
): void {
  for (const fullContent of [false, true]) {
    const compositeKey = workItemDetailQuery.keyOf({
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      key,
      fullContent,
    });
    if (compositeKey === null) {
      continue;
    }
    const controller = controllers.get(compositeKey);
    if (controller) {
      controller.fetchToken += 1;
      controller.hasData = true;
      controller.lastFetchedAt = Date.now();
    }
    setQueryState(compositeKey, {
      data: detail,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Invalidation
//
// Mirrors React Query's "refetch active queries, drop the rest" invalidation
// previously triggered via `queryClient.invalidateQueries({ queryKey:
// workItemsQueryKeys.all })`, scoped by environment and (optionally) project.
// ---------------------------------------------------------------------------

export function invalidateWorkItems(input?: {
  readonly environmentId?: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
}): void {
  const environmentId = input?.environmentId ?? null;
  const projectId = input?.projectId ?? null;

  for (const controller of controllers.values()) {
    if (environmentId !== null && controller.environmentId !== environmentId) {
      continue;
    }
    if (projectId !== null && (controller.projectId as ProjectId | null) !== projectId) {
      continue;
    }
    controller.hasData = false;
    controller.lastFetchedAt = 0;
    workItemsRegistry.cancel(controller);
    if (controller.subscriberCount > 0) {
      void runController(controller);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetWorkItemsAtomsForTests(): void {
  workItemsRegistry.resetForTests();
}
