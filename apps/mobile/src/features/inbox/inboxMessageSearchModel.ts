import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";

/** Shorter queries search titles only: one letter matches nearly every message. */
export const INBOX_MESSAGE_SEARCH_MIN_LENGTH = 2;
/** Waits for typing to pause before asking the nodes, as web's palette does. */
export const INBOX_MESSAGE_SEARCH_DEBOUNCE_MS = 200;
/** Matches asked of each node per query. */
export const INBOX_MESSAGE_SEARCH_LIMIT = 20;
/** A machine that has not answered by then adds nothing to this query. */
export const INBOX_MESSAGE_SEARCH_TIMEOUT_MS = 8_000;

/** The message a search found in one thread, shown under its row and opened at. */
export interface InboxMessageMatch {
  readonly messageId: MessageId;
  readonly snippet: string;
  readonly timestamp: string;
}

export interface EnvironmentMessageSearchResult {
  readonly environmentId: EnvironmentId;
  readonly results: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly snippet: string;
    readonly timestamp: string;
  }>;
}

/**
 * Whether the answer to `previous` may stay up while `next` runs: only while
 * the person refines the same text (types on, or deletes back), so a fresh
 * search never flashes another search's threads.
 */
export function isRelatedSearchQuery(previous: string, next: string): boolean {
  const before = previous.toLocaleLowerCase();
  const after = next.toLocaleLowerCase();
  return after.startsWith(before) || before.startsWith(after);
}

/** The query a node search runs for what the person typed, or null for none. */
export function messageSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  return trimmed.length >= INBOX_MESSAGE_SEARCH_MIN_LENGTH ? trimmed : null;
}

/** Every node's matches by scoped thread key, the newest message per thread. */
export function mergeInboxMessageMatches(
  answers: ReadonlyArray<EnvironmentMessageSearchResult>,
): ReadonlyMap<string, InboxMessageMatch> {
  const matches = new Map<string, InboxMessageMatch>();
  for (const answer of answers) {
    for (const result of answer.results) {
      const key = `${answer.environmentId}:${result.threadId}`;
      const previous = matches.get(key);
      if (previous && previous.timestamp >= result.timestamp) continue;
      matches.set(key, {
        messageId: result.messageId,
        snippet: result.snippet,
        timestamp: result.timestamp,
      });
    }
  }
  return matches;
}

export interface SnippetPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

/**
 * A snippet cut into plain and highlighted parts: every case-insensitive
 * occurrence of each word of the query is highlighted, overlaps merged.
 */
export function splitSnippet(snippet: string, query: string): ReadonlyArray<SnippetPart> {
  const haystack = snippet.toLocaleLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean))) {
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(token, from);
      if (index < 0) break;
      ranges.push([index, index + token.length]);
      from = index + token.length;
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const parts: SnippetPart[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      parts.push({ text: snippet.slice(cursor, start), highlighted: false, start: cursor });
    }
    parts.push({ text: snippet.slice(start, end), highlighted: true, start });
    cursor = end;
  }
  if (cursor < snippet.length) {
    parts.push({ text: snippet.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}
