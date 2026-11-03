// Pure rules of `useWorkspacePathSearch` (useProject.ts), apart for unit
// tests. Only that module imports them: another importer could split this
// module out of the hook's chunk into a file of its own.

import type { ProjectSearchEntriesResult, ServerConfig } from "@ryco/contracts";

/**
 * Whether the environment's live server config says `projects.searchEntries`
 * accepts an empty query. Read from the server config, not the environment
 * descriptor: hosted nodes get a synthetic descriptor without it.
 */
export function selectServerListsEmptyPathQuery(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.projectSearchEmptyQuery === true;
}

/**
 * Whether a path picker sends a workspace search. A bare query lists the
 * shallowest entries (and warms the server's index) only on servers that
 * advertise empty-query support; older ones reject it, so there the picker
 * waits for the first typed character.
 */
export function shouldRequestWorkspacePathSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly serverListsEmptyQuery: boolean;
}): boolean {
  return input.enabled && (input.query.length > 0 || input.serverListsEmptyQuery);
}

/**
 * Whether a picker's results for `dataQuery` may stand in for `query` while
 * it loads: results of a query being extended or shortened are, but nothing
 * stands in between the bare listing and a typed search.
 */
export function isRelatedPathQuery(dataQuery: string | null, query: string): boolean {
  if (dataQuery === null) return false;
  return (dataQuery.length === 0) === (query.length === 0);
}

/** The last results a path picker received for a query it sent itself. */
export interface OwnPathSearchResult {
  readonly scopeKey: string;
  /** The normalized query they answer. */
  readonly query: string;
  readonly data: ProjectSearchEntriesResult;
}

/**
 * A picker's own results after its scope changed: the scope's latest answer
 * when it answers the query this picker sent, else `current` (the same
 * object, so an unchanged answer is not remembered again).
 */
export function rememberOwnPathSearchResult(
  current: OwnPathSearchResult | null,
  scope: {
    readonly scopeKey: string | null;
    /** The normalized query the picker sent, or null when it sends none. */
    readonly requestedQuery: string | null;
    readonly data: ProjectSearchEntriesResult | null;
    readonly dataQuery: string | null;
  },
): OwnPathSearchResult | null {
  const { scopeKey, requestedQuery, data, dataQuery } = scope;
  if (scopeKey === null || requestedQuery === null || data === null) return current;
  if (dataQuery !== requestedQuery) return current;
  if (current?.scopeKey === scopeKey && current.query === dataQuery && current.data === data) {
    return current;
  }
  return { scopeKey, query: dataQuery, data };
}

/**
 * What a path picker shows for its typed (normalized) query. Every picker of
 * a workspace shares one search scope, whose latest answer can be to another
 * picker's query: it shows only when it answers the typed query. Otherwise
 * the picker's own last results stand in while the typed query loads.
 */
export function selectPathSearchResults(input: {
  readonly scopeKey: string | null;
  readonly data: ProjectSearchEntriesResult | null;
  readonly dataQuery: string | null;
  readonly ownResult: OwnPathSearchResult | null;
  readonly query: string;
}): ProjectSearchEntriesResult | null {
  if (input.data !== null && input.dataQuery === input.query) return input.data;
  const own = input.ownResult;
  if (own === null || own.scopeKey !== input.scopeKey) return null;
  return isRelatedPathQuery(own.query, input.query) ? own.data : null;
}
