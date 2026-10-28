import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectSearchEntriesResult } from "@ryco/contracts";
import { normalizeWorkspaceEntryQuery } from "@ryco/shared/workspaceEntrySearch";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { readEnvironmentApiForConnection } from "../environmentApi";
import { useEnvironmentServerConfigSelector } from "../hooks/useChatsAvailability";

import {
  canResolveProjectSearchEntriesLocally,
  DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT,
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
  retryProjectSearchEntries,
  watchFilesystemBrowse,
} from "./projectAtoms";
import {
  type OwnPathSearchResult,
  rememberOwnPathSearchResult,
  selectPathSearchResults,
  selectServerListsEmptyPathQuery,
  shouldRequestWorkspacePathSearch,
} from "./workspacePathSearch";

const WORKSPACE_PATH_SEARCH_DEBOUNCE_MS = 120;
/**
 * Every path picker of a workspace searches one cache scope, so each answers
 * from what another loaded. The scope's latest answer is shared too: each
 * picker shows only answers to its own queries.
 */
const WORKSPACE_PATH_SEARCH_LIMIT = DEFAULT_PROJECT_SEARCH_ENTRIES_LIMIT;

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

export interface WorkspacePathSearchInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /** The query as typed. */
  readonly query: string;
  /** Whether the picker is open: a closed one requests nothing. */
  readonly enabled: boolean;
}

export interface WorkspacePathSearch {
  /**
   * Results for the query, or for a related one while it loads; null when
   * none may stand in for it.
   */
  readonly results: ProjectSearchEntriesResult | null;
  /** Whether a search is sent: a bare query only on servers that list the workspace for one. */
  readonly requestsSearch: boolean;
  /** The typing debounce or the server has yet to answer. */
  readonly isLoading: boolean;
  /** The scope has answered a search; until then the server is usually building its index. */
  readonly hasResults: boolean;
  readonly error: Error | null;
  /** Re-sends the scope's last search, bypassing the cache. */
  readonly retry: () => void;
}

/**
 * Workspace path search for a picker (the composer's `@` menu, quick open)
 * over `useProjectSearchEntries`: typing is debounced unless cached results
 * already answer the query, and results of an unrelated query, or of another
 * picker's, never stand in for the typed one.
 */
export function useWorkspacePathSearch(input: WorkspacePathSearchInput): WorkspacePathSearch {
  const { environmentId, cwd, query, enabled } = input;
  // Older servers reject an empty search query; until the server's live config
  // says it lists the workspace for one, a bare query waits for the first
  // typed character. A narrow selection: config pushes must not re-render the
  // picker.
  const serverListsEmptyQuery = useEnvironmentServerConfigSelector(
    environmentId,
    selectServerListsEmptyPathQuery,
  );
  const [debouncedQuery, queryDebouncer] = useDebouncedValue(
    query,
    { wait: WORKSPACE_PATH_SEARCH_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  // A bare query requests the top-level listing at once, which also warms the
  // server's index while the user types. A query answerable from cached
  // results (narrowing a complete prefix result) skips the debounce.
  const resolvesLocally =
    enabled &&
    query.length > 0 &&
    canResolveProjectSearchEntriesLocally({
      environmentId,
      cwd,
      query,
      limit: WORKSPACE_PATH_SEARCH_LIMIT,
    });
  const effectiveQuery = query.length === 0 || resolvesLocally ? query : debouncedQuery;
  const requestsSearch = shouldRequestWorkspacePathSearch({
    enabled,
    query: effectiveQuery,
    serverListsEmptyQuery,
  });
  const entries = useProjectSearchEntries({
    environmentId,
    cwd,
    query: effectiveQuery,
    enabled: requestsSearch,
    limit: WORKSPACE_PATH_SEARCH_LIMIT,
  });
  // Another picker's search replaces the scope's latest answer, so this one
  // keeps the last answer to a query it sent: closing quick open must not
  // leave its results in the `@` menu as the answer to the menu's query.
  // Remembered during render, so it shows in the commit it arrives in.
  const scopeKey = resolveProjectSearchEntriesScopeKey({
    environmentId,
    cwd,
    limit: WORKSPACE_PATH_SEARCH_LIMIT,
  });
  const [ownResult, setOwnResult] = useState<OwnPathSearchResult | null>(null);
  const nextOwnResult = rememberOwnPathSearchResult(ownResult, {
    scopeKey,
    requestedQuery: requestsSearch ? normalizeWorkspaceEntryQuery(effectiveQuery) : null,
    data: entries.data,
    dataQuery: entries.dataQuery,
  });
  if (nextOwnResult !== ownResult) {
    setOwnResult(nextOwnResult);
  }
  // Judged against what the user typed, not the debounced query: the bare
  // listing must not stand in for a typed character while its search waits.
  const results = selectPathSearchResults({
    scopeKey,
    data: entries.data,
    dataQuery: entries.dataQuery,
    ownResult: nextOwnResult,
    query: normalizeWorkspaceEntryQuery(query),
  });
  const isLoading =
    enabled &&
    ((query.length > 0 && !resolvesLocally && queryDebouncer.state.isPending) ||
      (requestsSearch && (entries.isLoading || entries.isFetching)));
  const retry = useCallback(() => {
    retryProjectSearchEntries({ environmentId, cwd, limit: WORKSPACE_PATH_SEARCH_LIMIT });
  }, [environmentId, cwd]);
  return {
    results,
    requestsSearch,
    isLoading,
    hasResults: entries.data !== null,
    error: entries.error,
    retry,
  };
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
