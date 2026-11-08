import type { EnvironmentId } from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import {
  INBOX_MESSAGE_SEARCH_DEBOUNCE_MS,
  INBOX_MESSAGE_SEARCH_LIMIT,
  INBOX_MESSAGE_SEARCH_TIMEOUT_MS,
  isRelatedSearchQuery,
  mergeInboxMessageMatches,
  messageSearchInFlight,
  messageSearchQuery,
  type EnvironmentMessageSearchResult,
  type InboxMessageMatch,
} from "./inboxMessageSearchModel";

const NO_MATCHES: ReadonlyMap<string, InboxMessageMatch> = new Map();

interface InboxMessageSearchState {
  /** The query the answers belong to. */
  readonly query: string | null;
  readonly answers: ReadonlyArray<EnvironmentMessageSearchResult>;
  /** Machines that answered, failed or timed out for `query`. */
  readonly settled: ReadonlyArray<EnvironmentId>;
}

const IDLE: InboxMessageSearchState = { query: null, answers: [], settled: [] };

/** One machine's search ended for `query`, with its results or without (failure, timeout). */
function settle(
  previous: InboxMessageSearchState,
  query: string,
  environmentId: EnvironmentId,
  results: EnvironmentMessageSearchResult["results"] | null,
): InboxMessageSearchState {
  const same = previous.query === query;
  const answers = same
    ? previous.answers.filter((answer) => answer.environmentId !== environmentId)
    : [];
  return {
    query,
    answers: results === null ? answers : [...answers, { environmentId, results }],
    settled: [
      ...(same ? previous.settled.filter((id) => id !== environmentId) : []),
      environmentId,
    ],
  };
}

export interface InboxMessageSearch {
  readonly matches: ReadonlyMap<string, InboxMessageMatch>;
  /** A machine has not answered this query yet (Search shows it as searching). */
  readonly searching: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Searches message text on every connected node once typing pauses
 * (`orchestration.searchThreadMessages`, a viewer read). Each machine's answer
 * shows as it arrives, so a slow or silent one holds nothing up; one that fails,
 * times out or has no live client adds nothing. The last answer stays up while
 * the person refines the same text, and never under an unrelated search.
 */
export function useInboxMessageSearch(
  query: string,
  environmentIds: ReadonlyArray<EnvironmentId>,
): InboxMessageSearch {
  const searchQuery = messageSearchQuery(query);
  const environmentKey = environmentIds.join("\n");
  const [state, setState] = useState<InboxMessageSearchState>(IDLE);
  // Runs the debounced node searches for the current query and drops a superseded answer.
  useEffect(() => {
    if (searchQuery === null || environmentKey.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const id of environmentKey.split("\n")) {
        const environmentId = id as EnvironmentId;
        const api = readEnvironmentApi(environmentId);
        if (!api) {
          // No live client: it will never answer, so it is not waited on.
          setState((previous) => settle(previous, searchQuery, environmentId, null));
          continue;
        }
        withTimeout(
          api.orchestration.searchThreadMessages({
            query: searchQuery,
            limit: INBOX_MESSAGE_SEARCH_LIMIT,
          }),
          INBOX_MESSAGE_SEARCH_TIMEOUT_MS,
        ).then(
          (results) => {
            if (!cancelled)
              setState((previous) => settle(previous, searchQuery, environmentId, results));
          },
          () => {
            if (!cancelled)
              setState((previous) => settle(previous, searchQuery, environmentId, null));
          },
        );
      }
    }, INBOX_MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentKey, searchQuery]);
  const matches = useMemo(() => mergeInboxMessageMatches(state.answers), [state.answers]);
  const showMatches =
    searchQuery !== null &&
    environmentKey.length > 0 &&
    state.query !== null &&
    isRelatedSearchQuery(state.query, searchQuery);
  return {
    matches: showMatches ? matches : NO_MATCHES,
    searching: messageSearchInFlight({
      query: searchQuery,
      environmentIds: environmentIds as ReadonlyArray<string>,
      settledQuery: state.query,
      settledEnvironmentIds: state.settled,
    }),
  };
}
