import { useNavigation } from "@react-navigation/native";

import {
  usePullRequestSearch,
  type PullRequestSearchResult,
} from "../pullRequests/usePullRequestSearch";
import { pullRequestSearchGroup } from "./pullRequestSearchSource";
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
  "pullRequests",
]);

/**
 * Every source's groups for the query. The sources are called one by one in
 * a fixed order, so hook order never changes between renders.
 */
export function useSearchSources(input: SearchSourceInput): ReadonlyArray<SearchGroup> {
  const navigation = useNavigation();
  const threads = useThreadSearch(input);
  // An empty query reads nothing: the PRs scope asks its node only while asked.
  const pullRequests = usePullRequestSearch(
    input.scopes.has("pullRequests") ? (input.query ?? "") : "",
  );
  if (!input.scopes.has("pullRequests")) return threads;
  return [
    ...threads,
    // Every PRs result opens the pull request screen; its params are the route's.
    pullRequestSearchGroup(pullRequests, (route) =>
      navigation.navigate(
        "ProjectPullRequest",
        route.params as PullRequestSearchResult["route"]["params"],
      ),
    ),
  ];
}
