import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GitResolvePullRequestResult, VcsRef } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  beginMutationTracking,
  endMutationTracking,
  fetchNextBranchesPage,
  flattenBranchRefs,
  getBranchesAtom,
  getBranchesTargetKey,
  getMutationRunningAtom,
  getResolvePullRequestAtom,
  getResolvePullRequestTargetKey,
  invalidateScopes,
  refreshBranches,
  type ResolvePullRequestState,
  watchBranches,
  watchResolvePullRequest,
} from "./gitAtoms";

export {
  gitScopeKey,
  projectScopeKey,
  invalidateScopes,
  prefetchBranches,
  type GitBranchesState,
  type ResolvePullRequestState,
} from "./gitAtoms";

// Git status keeps its existing atom-backed implementation; re-exported here so
// callers can import the whole git data surface from one module.
export { useGitStatus, refreshGitStatus } from "../lib/gitStatusState";

// ---------------------------------------------------------------------------
// Branch (ref) search
// ---------------------------------------------------------------------------

export interface UseGitBranchesTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string;
}

export interface UseGitBranchesResult {
  readonly refs: ReadonlyArray<VcsRef>;
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly fetchNextPage: () => void;
  readonly refresh: () => void;
}

export function useGitBranches(target: UseGitBranchesTarget): UseGitBranchesResult {
  const { environmentId, cwd, query } = target;
  const targetKey = getBranchesTargetKey({ environmentId, cwd, query });

  useEffect(() => watchBranches({ environmentId, cwd, query }), [environmentId, cwd, query]);

  const state = useAtomValue(getBranchesAtom(targetKey));
  const refs = useMemo(() => flattenBranchRefs(state.pages), [state.pages]);
  const lastPage = state.pages[state.pages.length - 1];
  const hasNextPage = lastPage ? lastPage.nextCursor !== null : false;
  const totalCount = state.pages[0]?.totalCount ?? 0;

  const fetchNextPage = useCallback(() => fetchNextBranchesPage(targetKey), [targetKey]);
  const refresh = useCallback(() => refreshBranches(targetKey), [targetKey]);

  return {
    refs,
    totalCount,
    hasNextPage,
    isFetchingNextPage: state.isFetchingNextPage,
    isPending: state.isPending,
    error: state.error,
    fetchNextPage,
    refresh,
  };
}

// ---------------------------------------------------------------------------
// Pull request resolution
// ---------------------------------------------------------------------------

export interface UseResolvePullRequestTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

/**
 * Resolve a pull request reference, fetching when the reference changes.
 */
export function useResolvePullRequest(
  target: UseResolvePullRequestTarget,
): ResolvePullRequestState {
  const { environmentId, cwd, reference } = target;
  const targetKey = getResolvePullRequestTargetKey({ environmentId, cwd, reference });

  useEffect(
    () => watchResolvePullRequest({ environmentId, cwd, reference }),
    [environmentId, cwd, reference],
  );

  return useAtomValue(getResolvePullRequestAtom(targetKey));
}

/**
 * Read a previously resolved pull request for a reference without triggering a
 * fetch. Used to keep a cached result visible while a debounced lookup runs.
 */
export function useCachedResolvedPullRequest(
  target: UseResolvePullRequestTarget,
): GitResolvePullRequestResult | null {
  const { environmentId, cwd, reference } = target;
  const targetKey = getResolvePullRequestTargetKey({ environmentId, cwd, reference });
  return useAtomValue(getResolvePullRequestAtom(targetKey)).data;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface UseGitMutationOptions<TArgs, TResult> {
  readonly mutationFn: (args: TArgs) => Promise<TResult>;
  /** Invalidation scope keys (e.g. `git:${cwd}`, `project:${cwd}`). */
  readonly invalidates?: ReadonlyArray<string>;
  /**
   * When to invalidate the scopes. `"success"` (default) only invalidates after
   * a successful mutation; `"settled"` invalidates on success and failure.
   */
  readonly invalidateOn?: "success" | "settled";
  /** Shared key used to expose "is running" state across components. */
  readonly trackingKey?: string | null;
}

export interface UseGitMutationResult<TArgs, TResult> {
  readonly mutate: (args: TArgs) => void;
  readonly mutateAsync: (args: TArgs) => Promise<TResult>;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly reset: () => void;
}

export function useGitMutation<TArgs = void, TResult = unknown>(
  options: UseGitMutationOptions<TArgs, TResult>,
): UseGitMutationResult<TArgs, TResult> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutateAsync = useCallback(async (args: TArgs): Promise<TResult> => {
    const opts = optionsRef.current;
    const trackingKey = opts.trackingKey ?? null;
    const invalidateOn = opts.invalidateOn ?? "success";
    const scopes = opts.invalidates ?? [];

    setIsPending(true);
    setError(null);
    if (trackingKey !== null) {
      beginMutationTracking(trackingKey);
    }

    try {
      const result = await opts.mutationFn(args);
      if (scopes.length > 0) {
        invalidateScopes(scopes);
      }
      if (mountedRef.current) {
        setIsPending(false);
      }
      return result;
    } catch (rawError) {
      const normalizedError = rawError instanceof Error ? rawError : new Error("Mutation failed.");
      if (invalidateOn === "settled" && scopes.length > 0) {
        invalidateScopes(scopes);
      }
      if (mountedRef.current) {
        setIsPending(false);
        setError(normalizedError);
      }
      throw normalizedError;
    } finally {
      if (trackingKey !== null) {
        endMutationTracking(trackingKey);
      }
    }
  }, []);

  const mutate = useCallback(
    (args: TArgs) => {
      void mutateAsync(args).catch(() => undefined);
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    setIsPending(false);
    setError(null);
  }, []);

  return { mutate, mutateAsync, isPending, error, reset };
}

/**
 * Reactively report whether any mutation registered under `trackingKey` is in
 * flight. Replaces `useIsMutating({ mutationKey })`.
 */
export function useIsGitMutating(trackingKey: string): boolean {
  return useAtomValue(getMutationRunningAtom(trackingKey)) > 0;
}

// ---------------------------------------------------------------------------
// Tracking key helpers
// ---------------------------------------------------------------------------

/**
 * Tracking-key kinds of the git actions a user starts from the git controls.
 * The mutations register under these and {@link useGitActionActivity} reads
 * them, so the two cannot drift apart.
 */
export const GIT_USER_ACTION_KIND = {
  runStackedAction: "run-stacked-action",
  pull: "pull",
  publishRepository: "publish-repository",
} as const;

export function gitMutationTrackingKey(
  kind: string,
  environmentId: string | null,
  cwd: string | null,
): string {
  return `git-mutation:${kind}:${environmentId ?? ""}:${cwd ?? ""}`;
}

/**
 * Whether a git action the user started from the git controls is in flight
 * for this checkout: a stacked commit/push/PR action, a pull, or a repository
 * publish. Those actions report their own progress and outcome, so other
 * surfaces read this to stay quiet about the changes they cause.
 */
export function useGitActionActivity(environmentId: string | null, cwd: string | null): boolean {
  const isRunStackedActionRunning = useIsGitMutating(
    gitMutationTrackingKey(GIT_USER_ACTION_KIND.runStackedAction, environmentId, cwd),
  );
  const isPullRunning = useIsGitMutating(
    gitMutationTrackingKey(GIT_USER_ACTION_KIND.pull, environmentId, cwd),
  );
  const isPublishRunning = useIsGitMutating(
    gitMutationTrackingKey(GIT_USER_ACTION_KIND.publishRepository, environmentId, cwd),
  );
  return isRunStackedActionRunning || isPullRunning || isPublishRunning;
}
