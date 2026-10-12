import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { readEnvironmentApiForConnection } from "../environmentApi";

import {
  EMPTY_FILESYSTEM_BROWSE_STATE,
  EMPTY_PROJECT_SEARCH_ENTRIES_STATE,
  getFilesystemBrowseStateAtom,
  getProjectSearchEntriesStateAtom,
  type FilesystemBrowseInput,
  type FilesystemBrowseState,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesState,
  prefetchFilesystemBrowse,
  releaseProjectSearchEntriesScope,
  requestProjectSearchEntries,
  resolveFilesystemBrowseKey,
  resolveProjectSearchEntriesScopeKey,
  retainProjectSearchEntriesScope,
  watchFilesystemBrowse,
} from "./projectAtoms";

/**
 * Atom-backed replacement for the former `useQuery(projectSearchEntriesQueryOptions(...))`.
 *
 * Results for a given environment/cwd scope are retained while a new query
 * loads, and requests are gated until an environment and cwd are present (an
 * empty query lists top-level entries and warms the server index). Only an
 * enabled observer (an open path menu) refetches when the scope is invalidated
 * through `invalidateProjectSearchEntries`; closed ones refetch on next use.
 */
export function useProjectSearchEntries(
  input: ProjectSearchEntriesInput,
): ProjectSearchEntriesState {
  const scopeKey = resolveProjectSearchEntriesScopeKey(input);
  const { environmentId, cwd, query, enabled, limit, staleTime } = input;

  useEffect(() => {
    if (environmentId === null || cwd === null || enabled === false) {
      return;
    }
    const scope = {
      environmentId,
      cwd,
      ...(limit !== undefined ? { limit } : {}),
    };
    retainProjectSearchEntriesScope(scope);
    return () => releaseProjectSearchEntriesScope(scope);
  }, [environmentId, cwd, limit, enabled]);

  useEffect(() => {
    requestProjectSearchEntries({
      environmentId,
      cwd,
      query,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(staleTime !== undefined ? { staleTime } : {}),
    });
  }, [environmentId, cwd, query, enabled, limit, staleTime]);

  const state = useAtomValue(getProjectSearchEntriesStateAtom(scopeKey));
  return scopeKey === null ? EMPTY_PROJECT_SEARCH_ENTRIES_STATE : state;
}

/**
 * Atom-backed replacement for the former `useQuery(filesystemBrowse)` reads in
 * the command palette. Each environment/cwd/path tuple is cached independently
 * with stale-time gating; `prefetchFilesystemBrowse` warms adjacent paths.
 */
export function useFilesystemBrowse(input: FilesystemBrowseInput): FilesystemBrowseState {
  const browseKey = resolveFilesystemBrowseKey(input);
  const environmentConnection = useSyncExternalStore(
    subscribeEnvironmentConnections,
    () => (input.environmentId === null ? null : readEnvironmentConnection(input.environmentId)),
    () => null,
  );
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const currentInput = inputRef.current;
    const api =
      currentInput.environmentId === null
        ? undefined
        : readEnvironmentApiForConnection(
            currentInput.environmentId,
            environmentConnection?.client ?? null,
          );
    return watchFilesystemBrowse(currentInput, api ?? null);
  }, [browseKey, environmentConnection]);

  const state = useAtomValue(getFilesystemBrowseStateAtom(browseKey));
  return browseKey === null ? EMPTY_FILESYSTEM_BROWSE_STATE : state;
}

export { prefetchFilesystemBrowse };
