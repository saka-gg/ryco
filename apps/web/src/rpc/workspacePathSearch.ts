// Pure rules of `useWorkspacePathSearch` (useProject.ts), apart for unit
// tests. Only that module imports them: another importer could split this
// module out of the hook's chunk into a file of its own.

import type { ServerConfig } from "@ryco/contracts";

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
 * Whether results for `dataQuery` may stand in for `query` while it loads:
 * results of a query being extended or shortened are, but nothing stands in
 * between the bare listing and a typed search.
 */
export function isRelatedPathQuery(dataQuery: string | null, query: string): boolean {
  if (dataQuery === null) return false;
  return (dataQuery.length === 0) === (query.length === 0);
}
