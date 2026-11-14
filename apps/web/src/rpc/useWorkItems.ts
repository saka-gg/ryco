import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectId,
  WorkItemDetail as WorkItemDetailModel,
  WorkItemProject,
  WorkItemSummary,
  WorkItemUpdateFields,
} from "@ryco/contracts";
import { useCallback, useEffect } from "react";

import { requireEnvironmentConnection } from "~/environments/runtime";
import {
  invalidateWorkItems,
  setWorkItemDetailCache,
  type WorkItemDetailInput,
  type WorkItemListInput,
  type WorkItemProjectsInput,
  type WorkItemQueryState,
  type WorkItemSearchInput,
  workItemDetailQuery,
  workItemListQuery,
  workItemProjectsQuery,
  workItemSearchQuery,
} from "./workItemsAtoms";
import { useMutation } from "./useMutation";

export {
  invalidateWorkItems,
  setWorkItemDetailCache,
  type WorkItemDetailInput,
  type WorkItemListInput,
  type WorkItemProjectsInput,
  type WorkItemQueryState,
  type WorkItemSearchInput,
} from "./workItemsAtoms";

export interface WorkItemQueryResult<T> extends WorkItemQueryState<T> {
  readonly refetch: () => void;
}

/**
 * Atom-backed replacement for `useQuery(workItemProjectsQueryOptions(...))`.
 */
export function useWorkItemProjects(
  input: WorkItemProjectsInput,
): WorkItemQueryResult<ReadonlyArray<WorkItemProject>> {
  const { environmentId, connectionId, siteUrl, enabled } = input;
  const cacheKey = workItemProjectsQuery.keyOf(input);

  useEffect(
    () =>
      workItemProjectsQuery.watch({
        environmentId,
        connectionId,
        ...(siteUrl !== undefined ? { siteUrl } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    [environmentId, connectionId, siteUrl, enabled],
  );

  const state = useAtomValue(workItemProjectsQuery.getAtom(cacheKey));
  const refetch = useCallback(() => workItemProjectsQuery.refresh(cacheKey), [cacheKey]);
  return { ...state, refetch };
}

/**
 * Atom-backed replacement for `useQuery(workItemListQueryOptions(...))`.
 */
export function useWorkItemList(
  input: WorkItemListInput,
): WorkItemQueryResult<ReadonlyArray<WorkItemSummary>> {
  const { environmentId, projectId, state: stateFilter, limit, enabled } = input;
  const cacheKey = workItemListQuery.keyOf(input);

  useEffect(
    () =>
      workItemListQuery.watch({
        environmentId,
        projectId,
        state: stateFilter,
        ...(limit !== undefined ? { limit } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    [environmentId, projectId, stateFilter, limit, enabled],
  );

  const state = useAtomValue(workItemListQuery.getAtom(cacheKey));
  const refetch = useCallback(() => workItemListQuery.refresh(cacheKey), [cacheKey]);
  return { ...state, refetch };
}

/**
 * Atom-backed replacement for `useQuery(workItemSearchQueryOptions(...))`.
 */
export function useWorkItemSearch(
  input: WorkItemSearchInput,
): WorkItemQueryResult<ReadonlyArray<WorkItemSummary>> {
  const { environmentId, projectId, query, limit, enabled } = input;
  const cacheKey = workItemSearchQuery.keyOf(input);

  useEffect(
    () =>
      workItemSearchQuery.watch({
        environmentId,
        projectId,
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    [environmentId, projectId, query, limit, enabled],
  );

  const state = useAtomValue(workItemSearchQuery.getAtom(cacheKey));
  const refetch = useCallback(() => workItemSearchQuery.refresh(cacheKey), [cacheKey]);
  return { ...state, refetch };
}

/**
 * Atom-backed replacement for `useQuery(workItemDetailQueryOptions(...))`.
 */
export function useWorkItemDetail(
  input: WorkItemDetailInput,
): WorkItemQueryResult<WorkItemDetailModel> {
  const { environmentId, projectId, key: workItemKey, fullContent, enabled } = input;
  const cacheKey = workItemDetailQuery.keyOf(input);

  useEffect(
    () =>
      workItemDetailQuery.watch({
        environmentId,
        projectId,
        key: workItemKey,
        ...(fullContent !== undefined ? { fullContent } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    [environmentId, projectId, workItemKey, fullContent, enabled],
  );

  const state = useAtomValue(workItemDetailQuery.getAtom(cacheKey));
  const refetch = useCallback(() => workItemDetailQuery.refresh(cacheKey), [cacheKey]);
  return { ...state, refetch };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface WorkItemMutationScope {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly key: string;
}

function requireWorkItemMutationScope(scope: WorkItemMutationScope): {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly key: string;
} {
  if (!scope.environmentId || !scope.projectId) {
    throw new Error("Cannot mutate this Jira work item.");
  }
  return {
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    key: scope.key,
  };
}

function workItemMutationSuccess(scope: WorkItemMutationScope) {
  return (detail: WorkItemDetailModel) => {
    if (!scope.environmentId || !scope.projectId) {
      return;
    }
    setWorkItemDetailCache(
      { environmentId: scope.environmentId, projectId: scope.projectId },
      scope.key,
      detail,
    );
    invalidateWorkItems({ environmentId: scope.environmentId, projectId: scope.projectId });
  };
}

export interface WorkItemMutationOptions {
  readonly onError?: (error: Error) => void;
  readonly onEditCommentSuccess?: () => void;
}

export function useUpdateWorkItemMutation(
  scope: WorkItemMutationScope,
  options?: WorkItemMutationOptions,
) {
  return useMutation({
    mutationFn: async (fields: WorkItemUpdateFields) => {
      const resolved = requireWorkItemMutationScope(scope);
      return requireEnvironmentConnection(resolved.environmentId).client.workItems.update({
        projectId: resolved.projectId,
        key: resolved.key,
        fields,
      });
    },
    onSuccess: workItemMutationSuccess(scope),
    onError: (error) => {
      options?.onError?.(error);
    },
  });
}

export function useAddWorkItemCommentMutation(
  scope: WorkItemMutationScope,
  options?: WorkItemMutationOptions,
) {
  return useMutation({
    mutationFn: async (body: string) => {
      const resolved = requireWorkItemMutationScope(scope);
      if (body.trim().length === 0) {
        throw new Error("Cannot add an empty Jira comment.");
      }
      return requireEnvironmentConnection(resolved.environmentId).client.workItems.addComment({
        projectId: resolved.projectId,
        key: resolved.key,
        body: body.trim(),
      });
    },
    onSuccess: workItemMutationSuccess(scope),
    onError: (error) => {
      options?.onError?.(error);
    },
  });
}

export function useEditWorkItemCommentMutation(
  scope: WorkItemMutationScope,
  options?: WorkItemMutationOptions,
) {
  return useMutation({
    mutationFn: async (input: { readonly commentId: string; readonly body: string }) => {
      const resolved = requireWorkItemMutationScope(scope);
      if (input.body.trim().length === 0) {
        throw new Error("Cannot save an empty Jira comment.");
      }
      return requireEnvironmentConnection(resolved.environmentId).client.workItems.editComment({
        projectId: resolved.projectId,
        key: resolved.key,
        commentId: input.commentId,
        body: input.body.trim(),
      });
    },
    onSuccess: (detail) => {
      options?.onEditCommentSuccess?.();
      workItemMutationSuccess(scope)(detail);
    },
    onError: (error) => {
      options?.onError?.(error);
    },
  });
}

export function useTransitionWorkItemMutation(
  scope: WorkItemMutationScope,
  options?: WorkItemMutationOptions,
) {
  return useMutation({
    mutationFn: async (transitionId: string) => {
      const resolved = requireWorkItemMutationScope(scope);
      return requireEnvironmentConnection(resolved.environmentId).client.workItems.transition({
        projectId: resolved.projectId,
        key: resolved.key,
        transitionId,
      });
    },
    onSuccess: workItemMutationSuccess(scope),
    onError: (error) => {
      options?.onError?.(error);
    },
  });
}

export function useImproveWorkItemDescriptionMutation(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly currentTitle?: string | undefined;
}) {
  return useMutation({
    mutationFn: async (payload: { readonly rough: string; readonly instructions: string }) => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("AI description improvement requires an active project path.");
      }
      return requireEnvironmentConnection(
        input.environmentId,
      ).client.textGeneration.generateIssueContent({
        cwd: input.cwd,
        mode: "polish",
        rough: payload.rough,
        ...(input.currentTitle !== undefined ? { currentTitle: input.currentTitle } : {}),
        ...(payload.instructions.trim().length > 0
          ? { customInstructions: payload.instructions.trim() }
          : {}),
      });
    },
  });
}
