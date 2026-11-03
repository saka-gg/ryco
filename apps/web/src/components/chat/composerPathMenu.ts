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
