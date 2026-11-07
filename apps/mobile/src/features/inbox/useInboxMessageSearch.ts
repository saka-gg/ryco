import type { EnvironmentId } from "@ryco/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import {
  INBOX_MESSAGE_SEARCH_DEBOUNCE_MS,
  INBOX_MESSAGE_SEARCH_LIMIT,
  mergeInboxMessageMatches,
  messageSearchQuery,
  type EnvironmentMessageSearchResult,
  type InboxMessageMatch,
} from "./inboxMessageSearchModel";

const NO_MATCHES: ReadonlyMap<string, InboxMessageMatch> = new Map();

interface InboxMessageSearchState {
  readonly query: string | null;
  readonly matches: ReadonlyMap<string, InboxMessageMatch>;
}

const IDLE: InboxMessageSearchState = { query: null, matches: NO_MATCHES };

/**
 * Searches message text on every connected node once typing pauses
 * (`orchestration.searchThreadMessages`, a viewer read). While the next answer
 * is on its way the last one stays, so rows found by message do not flicker out
 * on every keystroke; clearing the search drops them at once. A node that fails
 * or has no live client adds nothing.
 */
export function useInboxMessageSearch(
  query: string,
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<string, InboxMessageMatch> {
  const searchQuery = messageSearchQuery(query);
  const environmentKey = environmentIds.join("\n");
  const [state, setState] = useState<InboxMessageSearchState>(IDLE);
  // Runs the debounced node searches for the current query and drops a superseded answer.
  useEffect(() => {
    if (searchQuery === null || environmentKey.length === 0) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const searches = environmentKey.split("\n").map((id) => {
        const environmentId = id as EnvironmentId;
        const api = readEnvironmentApi(environmentId);
        if (!api) return Promise.resolve<EnvironmentMessageSearchResult | null>(null);
        return api.orchestration
          .searchThreadMessages({ query: searchQuery, limit: INBOX_MESSAGE_SEARCH_LIMIT })
          .then((results) => ({ environmentId, results }))
          .catch(() => null);
      });
      void Promise.all(searches).then((answers) => {
        if (cancelled) return;
        setState({
          query: searchQuery,
          matches: mergeInboxMessageMatches(
            answers.filter((answer): answer is EnvironmentMessageSearchResult => answer !== null),
          ),
        });
      });
    }, INBOX_MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentKey, searchQuery]);
  return searchQuery !== null && state.query !== null ? state.matches : NO_MATCHES;
}
