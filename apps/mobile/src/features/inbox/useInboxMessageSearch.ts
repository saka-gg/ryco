import type { EnvironmentId } from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import {
  INBOX_MESSAGE_SEARCH_DEBOUNCE_MS,
  INBOX_MESSAGE_SEARCH_LIMIT,
  INBOX_MESSAGE_SEARCH_TIMEOUT_MS,
  isRelatedSearchQuery,
  mergeInboxMessageMatches,
  messageSearchQuery,
  type EnvironmentMessageSearchResult,
  type InboxMessageMatch,
} from "./inboxMessageSearchModel";

const NO_MATCHES: ReadonlyMap<string, InboxMessageMatch> = new Map();

interface InboxMessageSearchState {
  /** The query the answers belong to. */
  readonly query: string | null;
  readonly answers: ReadonlyArray<EnvironmentMessageSearchResult>;
}

const IDLE: InboxMessageSearchState = { query: null, answers: [] };

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
): ReadonlyMap<string, InboxMessageMatch> {
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
        if (!api) continue;
        withTimeout(
          api.orchestration.searchThreadMessages({
            query: searchQuery,
            limit: INBOX_MESSAGE_SEARCH_LIMIT,
          }),
          INBOX_MESSAGE_SEARCH_TIMEOUT_MS,
        ).then(
          (results) => {
            if (cancelled) return;
            setState((previous) => ({
              query: searchQuery,
              answers: [
                ...(previous.query === searchQuery
                  ? previous.answers.filter((answer) => answer.environmentId !== environmentId)
                  : []),
                { environmentId, results },
              ],
            }));
          },
          () => undefined,
        );
      }
    }, INBOX_MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentKey, searchQuery]);
  const matches = useMemo(() => mergeInboxMessageMatches(state.answers), [state.answers]);
  return searchQuery !== null &&
    environmentKey.length > 0 &&
    state.query !== null &&
    isRelatedSearchQuery(state.query, searchQuery)
    ? matches
    : NO_MATCHES;
}
