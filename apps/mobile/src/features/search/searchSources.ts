import { useThreadSearch } from "./useThreadSearch";
import type { SearchGroup, SearchScope } from "./searchModel";

/** What every search source is asked. */
export interface SearchSourceInput {
  /** The trimmed query, or null while the field is empty. */
  readonly query: string | null;
  /** The scopes the selected chip searches; a source skips the others. */
  readonly scopes: ReadonlySet<SearchScope>;
}

/**
 * A search source: a hook that answers the query for the scopes it serves,
 * one group per scope. It runs on every render of Search, so it must debounce
 * any node request itself and answer only for the scopes it was asked.
 */
export type SearchSourceHook = (input: SearchSourceInput) => ReadonlyArray<SearchGroup>;

/**
 * The scopes some source serves. Search shows a chip for each.
 *
 * To plug a scope in: implement a `SearchSourceHook` in your feature, add the
 * scope here, and call the hook in `useSearchSources` below — one line each.
 */
export const AVAILABLE_SEARCH_SCOPES: ReadonlySet<SearchScope> = new Set<SearchScope>([
  "chats",
  "messages",
]);

/**
 * Every source's groups for the query. The sources are called one by one in
 * a fixed order, so hook order never changes between renders.
 */
export function useSearchSources(input: SearchSourceInput): ReadonlyArray<SearchGroup> {
  const threads = useThreadSearch(input);
  // PRs mount point, once the PRs round (#1138) is on main: add "pullRequests" to
  // AVAILABLE_SEARCH_SCOPES, then
  //   const prs = usePullRequestSearch(input.scopes.has("pullRequests") ? (input.query ?? "") : "");
  //   return [...threads, pullRequestSearchGroup(prs, (route) => navigation.navigate(route.name, route.params))];
  return threads;
}
