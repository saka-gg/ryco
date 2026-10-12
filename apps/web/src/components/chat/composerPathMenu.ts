import type { ServerConfig } from "@ryco/contracts";

/**
 * What the command menu shows when it has no items (or beside them): the empty
 * text, a loading line, a failed search with a retry, or a note about partial
 * results.
 */
export interface ComposerMenuEmptyState {
  readonly text: string;
  readonly loadingText?: string;
  readonly errorText?: string;
  readonly onRetry?: () => void;
  readonly footnote?: string;
}

/**
 * Whether the environment's live server config says `projects.searchEntries`
 * accepts an empty query. Read from the server config, not the environment
 * descriptor: hosted nodes get a synthetic descriptor without it.
 */
export function selectServerListsEmptyPathQuery(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.projectSearchEmptyQuery === true;
}

/**
 * Whether the `@` path menu sends a workspace search. A bare `@` lists the
 * shallowest entries (and warms the server's index) only on servers that
 * advertise empty-query support; older ones reject it, so there the menu waits
 * for the first typed character.
 */
export function shouldRequestComposerPathSearch(input: {
  readonly isPathTrigger: boolean;
  readonly query: string;
  readonly serverListsEmptyQuery: boolean;
}): boolean {
  return input.isPathTrigger && (input.query.length > 0 || input.serverListsEmptyQuery);
}

/**
 * Whether results for `dataQuery` may stand in for `query` while it loads:
 * results of a query being extended or shortened are, but nothing stands in
 * between the bare trigger's listing and a typed search.
 */
export function isRelatedPathQuery(dataQuery: string | null, query: string): boolean {
  if (dataQuery === null) return false;
  return (dataQuery.length === 0) === (query.length === 0);
}

/**
 * Empty, loading, error and partial-result presentation of the `@` path menu.
 * Every search the menu sent reports its failure (with a retry) instead of
 * looking like an empty result.
 */
export function resolveComposerPathMenuEmptyState(input: {
  readonly requestsSearch: boolean;
  readonly triggerQuery: string;
  readonly hasResults: boolean;
  readonly error: Error | null;
  readonly partial: boolean;
  readonly onRetry: () => void;
}): ComposerMenuEmptyState {
  const error = input.requestsSearch ? input.error : null;
  return {
    text:
      input.requestsSearch || input.triggerQuery.length > 0
        ? "No matching files or folders."
        : "Type to search files and folders.",
    // The first search of a workspace usually waits for its index to build.
    loadingText: input.hasResults ? "Searching workspace files…" : "Indexing workspace…",
    ...(error !== null
      ? { errorText: "Couldn't search workspace files.", onRetry: input.onRetry }
      : {}),
    ...(input.partial ? { footnote: "Showing results from part of the workspace." } : {}),
  };
}
