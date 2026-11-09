// Find in this chat (web's find bar): the messages a query matches, oldest first, from the loaded
// messages and the node's search (which also reaches messages not loaded yet). Going to a hit
// anchors the chat at its message, the way a link to a message does.
import { createThreadMessageSearchMatcher } from "@ryco/client-runtime/state/session/threadMessageSearch";
import type { MessageId } from "@ryco/contracts";

export interface ThreadFindMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadFindHit {
  readonly messageId: MessageId;
  readonly createdAt: string;
}

/** The node answers searches of two characters or more. */
export const THREAD_FIND_SERVER_MIN_CHARS = 2;

/** Loaded user and agent messages whose text matches `query`. */
export function findLoadedMessages(
  messages: ReadonlyArray<ThreadFindMessage>,
  query: string,
): ThreadFindHit[] {
  const matcher = createThreadMessageSearchMatcher(query);
  if (!matcher) return [];
  const hits: ThreadFindHit[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    matcher.lastIndex = 0;
    if (matcher.test(message.text))
      hits.push({ messageId: message.id, createdAt: message.createdAt });
  }
  return hits;
}

/** Loaded and server hits as one list, each message once, oldest first. */
export function mergeThreadFindHits(
  loaded: ReadonlyArray<ThreadFindHit>,
  server: ReadonlyArray<ThreadFindHit>,
): ThreadFindHit[] {
  const byId = new Map<string, ThreadFindHit>();
  for (const hit of [...server, ...loaded]) byId.set(hit.messageId, hit);
  return [...byId.values()].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.messageId.localeCompare(right.messageId),
  );
}

/** "3 / 12", "No results", or "" before anything is typed. */
export function threadFindStatus(input: {
  readonly query: string;
  readonly hits: number;
  readonly index: number;
  readonly searching: boolean;
}): string {
  if (input.query.trim().length === 0) return "";
  if (input.hits === 0) return input.searching ? "Searching…" : "No results";
  return `${input.index + 1} / ${input.hits}`;
}
