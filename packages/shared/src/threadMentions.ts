import { ThreadId } from "@ryco/contracts/base-schemas";
import { MAX_THREAD_REFERENCES_PER_MESSAGE } from "@ryco/contracts/orchestration";

/**
 * A thread mention is an ordinary `@` mention whose path names a thread:
 * `@thread:<id>`. Riding on the mention syntax keeps cursor, selection and
 * deletion behaviour identical to file chips; only the chip that renders it
 * differs. The id charset never needs quoting, so the token stays readable to
 * an agent that receives it without the server's excerpt.
 */
const THREAD_MENTION_PATH_PREFIX = "thread:";
const THREAD_MENTION_ID_SOURCE = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const THREAD_MENTION_PATH_REGEX = new RegExp(`^thread:(${THREAD_MENTION_ID_SOURCE})$`);
// Also at the end of the text: a sent prompt is trimmed, so its last chip has
// no whitespace after it.
const THREAD_MENTION_TOKEN_REGEX = new RegExp(
  `(^|\\s)@thread:(${THREAD_MENTION_ID_SOURCE})(?=\\s|$)`,
  "g",
);

export interface ThreadMentionMatch {
  readonly threadId: ThreadId;
  /** Offset of the `@`. */
  readonly start: number;
  readonly end: number;
}

/** Whether a thread id can be written as a mention token. */
export function isThreadMentionableId(threadId: string): boolean {
  return THREAD_MENTION_PATH_REGEX.test(`${THREAD_MENTION_PATH_PREFIX}${threadId}`);
}

/** The mention path (without `@`) that names a thread. */
export function formatThreadMentionPath(threadId: ThreadId): string {
  return `${THREAD_MENTION_PATH_PREFIX}${threadId}`;
}

/** The thread a mention path names, or null for a file mention. */
export function threadIdFromMentionPath(path: string): ThreadId | null {
  const match = THREAD_MENTION_PATH_REGEX.exec(path);
  return match?.[1] ? ThreadId.make(match[1]) : null;
}

export function matchThreadMentions(text: string): ThreadMentionMatch[] {
  const matches: ThreadMentionMatch[] = [];
  for (const match of text.matchAll(THREAD_MENTION_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const id = match[2];
    if (!id) continue;
    const start = (match.index ?? 0) + prefix.length;
    matches.push({
      threadId: ThreadId.make(id),
      start,
      end: start + match[0].length - prefix.length,
    });
  }
  return matches;
}

/**
 * The threads a prompt mentions, in first-mention order, without duplicates or
 * the sending thread itself, capped at what one message may carry.
 */
export function extractThreadReferences(text: string, sendingThreadId?: ThreadId): ThreadId[] {
  const references: ThreadId[] = [];
  for (const { threadId } of matchThreadMentions(text)) {
    if (threadId === sendingThreadId || references.includes(threadId)) continue;
    references.push(threadId);
    if (references.length === MAX_THREAD_REFERENCES_PER_MESSAGE) break;
  }
  return references;
}
