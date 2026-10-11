import { useAtomValue } from "@effect/atom-react";
import type {
  AtlassianConnectionSummary,
  AtlassianProjectLink,
  AtlassianSaveProjectLinkInput,
  EnvironmentId,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Atom } from "effect/reactivity";

import { requireEnvironmentConnection } from "~/environments/runtime";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import { useAsyncMutation } from "./useWorkItems";
import { invalidateWorkItems } from "./workItemsAtoms";
import {
  type AtlassianConnectionsInput,
  type AtlassianProjectLinkInput,
  type AtlassianQueryState,
  atlassianConnectionsQuery,
  atlassianProjectLinkQuery,
  invalidateAtlassian,
} from "./atlassianAtoms";

export {
  invalidateAtlassian,
  type AtlassianConnectionsInput,
  type AtlassianProjectLinkInput,
  type AtlassianQueryState,
} from "./atlassianAtoms";

export interface AtlassianQueryResult<T> extends AtlassianQueryState<T> {
  readonly refetch: () => void;
}

/**
 * Atom-backed replacement for `useQuery({ queryKey: ["atlassian", "connections", ...] })`.
 */
export function useAtlassianConnections(
  input: AtlassianConnectionsInput,
): AtlassianQueryResult<ReadonlyArray<AtlassianConnectionSummary>> {
  const { environmentId, enabled } = input;
  const cacheKey = atlassianConnectionsQuery.keyOf(input);

  useEffect(
    () =>
      atlassianConnectionsQuery.watch({
        environmentId,
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    [environmentId, enabled],
  );

  const state = useAtomValue(atlassianConnectionsQuery.getAtom(cacheKey));
  const refetch = useCallback(() => atlassianConnectionsQuery.refresh(cacheKey), [cacheKey]);
  return { ...state, refetch };
}

/**
 * Atom-backed replacement for `useQuery({ queryKey: ["atlassian", "project-link", ...] })`.
 */
export function useAtlassianProjectLink(
  input: AtlassianProjectLinkInput,
): AtlassianQueryResult<AtlassianProjectLink | null> {
  const { environmentId, projectId, enabled } = input;
  const cacheKey = atlassianProjectLinkQuery.keyOf(input);

  useEffect(
    () =>
      atlassianProjectLinkQuery.watch({
        environmentId,
        projectId,
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    [environmentId, projectId, enabled],
  );

  const state = useAtomValue(atlassianProjectLinkQuery.getAtom(cacheKey));
  const refetch = useCallback(() => atlassianProjectLinkQuery.refresh(cacheKey), [cacheKey]);
  return { ...state, refetch };
}

// ---------------------------------------------------------------------------
// Batch reads (sidebar / multi-project surfaces)
// ---------------------------------------------------------------------------

interface KeyedAtlassianQuery<TInput, TData> {
  readonly keyOf: (input: TInput) => string | null;
  readonly watch: (input: TInput) => () => void;
  readonly getAtom: (compositeKey: string | null) => Atom.Atom<AtlassianQueryState<TData>>;
  readonly getSnapshot: (compositeKey: string | null) => AtlassianQueryState<TData>;
}

function atlassianQueryStatesEqual<T>(
  left: AtlassianQueryState<T>,
  right: AtlassianQueryState<T>,
): boolean {
  return (
    left.data === right.data &&
    left.isLoading === right.isLoading &&
    left.isFetching === right.isFetching &&
    left.isError === right.isError &&
    left.error === right.error
  );
}

function useAtlassianQueryBatch<TInput, TData>(
  query: KeyedAtlassianQuery<TInput, TData>,
  inputs: ReadonlyArray<TInput>,
): ReadonlyArray<AtlassianQueryState<TData>> {
  const cacheKeys = useMemo(() => inputs.map((input) => query.keyOf(input)), [inputs, query]);
  const batchSignature = useMemo(() => cacheKeys.join("\u0001"), [cacheKeys]);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const cacheKeysRef = useRef(cacheKeys);
  cacheKeysRef.current = cacheKeys;
  const snapshotRef = useRef<ReadonlyArray<AtlassianQueryState<TData>>>([]);

  useEffect(() => {
    const unsubs = inputsRef.current.map((input) => query.watch(input));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [batchSignature, query]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubs = cacheKeysRef.current.map((key) =>
        appAtomRegistry.subscribe(query.getAtom(key), onStoreChange),
      );
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    [batchSignature, query],
  );

  const getSnapshot = useCallback(() => {
    const next = cacheKeysRef.current.map((key) => query.getSnapshot(key));
    const previous = snapshotRef.current;
    if (
      previous.length === next.length &&
      previous.every((state, index) => atlassianQueryStatesEqual(state, next[index]!))
    ) {
      return previous;
    }
    snapshotRef.current = next;
    return next;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAtlassianProjectLinkBatch(
  inputs: ReadonlyArray<AtlassianProjectLinkInput>,
): ReadonlyArray<AtlassianQueryState<AtlassianProjectLink | null>> {
  return useAtlassianQueryBatch(atlassianProjectLinkQuery, inputs);
}

export function useAtlassianConnectionsBatch(
  environmentIds: ReadonlyArray<EnvironmentId>,
  enabled: boolean,
): ReadonlyArray<AtlassianQueryState<ReadonlyArray<AtlassianConnectionSummary>>> {
  const inputs = useMemo(
    () => environmentIds.map((environmentId) => ({ environmentId, enabled })),
    [enabled, environmentIds],
  );
  return useAtlassianQueryBatch(atlassianConnectionsQuery, inputs);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useSaveAtlassianProjectLinkMutation(input: {
  readonly environmentId: EnvironmentId | null;
  readonly onSuccess?: () => void;
  readonly onError?: (error: Error) => void;
}) {
  return useAsyncMutation({
    mutationFn: async (payload: AtlassianSaveProjectLinkInput) => {
      if (!input.environmentId) {
        throw new Error("No project connection is available.");
      }
      return requireEnvironmentConnection(input.environmentId).client.atlassian.saveProjectLink(
        payload,
      );
    },
    onSuccess: (_data, payload) => {
      invalidateAtlassian({ environmentId: input.environmentId });
      invalidateWorkItems({
        environmentId: input.environmentId,
        projectId: payload.projectId,
      });
      input.onSuccess?.();
    },
    onError: (error) => {
      input.onError?.(error);
    },
  });
}
