import type { ThreadId } from "@ryco/contracts/base-schemas";
import {
  captureThreadReadContent,
  decodeThreadReadContent,
  type CachedThreadContent,
} from "./readCache.ts";
import type { EnvironmentState } from "./store.ts";

/**
 * Which conversations a display-only content cache keeps, how much of them,
 * and how a saved record is read back. Pure: storage, encryption and the
 * record's non-content fields belong to the platform that owns the cache.
 */

/** Threads whose display content one environment's record may hold. */
export const THREAD_CONTENT_CACHE_MAX_THREADS = 32;
/** Serialized size one environment's record may reach before older threads are dropped. */
export const THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES = 1_900_000;
/** Content entries read back from one saved record. */
export const THREAD_CONTENT_CACHE_DECODE_MAX_CONTENT_ENTRIES = THREAD_CONTENT_CACHE_MAX_THREADS;
/** Composer drafts, and separately scroll positions, read back from one saved record. */
export const THREAD_CONTENT_CACHE_DECODE_MAX_DRAFT_ENTRIES = 64;
/** Longest composer draft saved or read back. */
export const THREAD_CONTENT_CACHE_MAX_DRAFT_CHARS = 100_000;

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export interface ThreadContentSelectionInput<Id extends string = string> {
  readonly threadIds: ReadonlyArray<Id>;
  readonly hasMessages: (threadId: Id) => boolean;
  /** The open thread, when it belongs to this environment. */
  readonly routedThreadId: Id | null | undefined;
  /** ISO timestamp of the last visit, if any. A thread never visited sorts first. */
  readonly lastVisitedAt: (threadId: Id) => string | null | undefined;
}

/**
 * The threads whose content is saved, in the order a record lists them: least
 * recently visited first and the open thread last, at most
 * `THREAD_CONTENT_CACHE_MAX_THREADS` of them (the most recent ones). Trimming
 * a record to its budget drops from the front of this order.
 */
export function selectThreadsForContentCache<Id extends string>(
  input: ThreadContentSelectionInput<Id>,
): Id[] {
  return input.threadIds
    .filter((threadId) => input.hasMessages(threadId))
    .map((threadId) => ({
      threadId,
      routed: threadId === input.routedThreadId,
      visitedAt: input.lastVisitedAt(threadId) ?? "",
    }))
    .toSorted(
      (left, right) =>
        Number(left.routed) - Number(right.routed) || left.visitedAt.localeCompare(right.visitedAt),
    )
    .slice(-THREAD_CONTENT_CACHE_MAX_THREADS)
    .map((entry) => entry.threadId);
}

export interface CapturedThreadContent {
  readonly threadId: ThreadId;
  readonly content: CachedThreadContent;
  /** UTF-8 length of this thread's serialized `"id":content` entry in a record. */
  readonly entryBytes: number;
}

type CapturedThreadEntry = CapturedThreadContent & {
  readonly messageIds: unknown;
  readonly messages: unknown;
};

export type ThreadContentSource = Pick<
  EnvironmentState,
  "messageIdsByThreadId" | "messageByThreadId"
>;

export interface ThreadContentCapture {
  /**
   * The display content of `threadIds`, in that order, re-capturing and
   * re-measuring only threads whose message list changed since the previous
   * capture of this environment: a streaming thread costs one capture, not
   * all of them.
   */
  readonly capture: (
    environmentId: string,
    state: ThreadContentSource,
    threadIds: ReadonlyArray<ThreadId>,
  ) => ReadonlyArray<CapturedThreadContent>;
  readonly forget: (environmentId: string) => void;
  readonly clear: () => void;
}

export function createThreadContentCapture(): ThreadContentCapture {
  const capturedByEnvironment = new Map<string, Map<ThreadId, CapturedThreadEntry>>();
  return {
    capture: (environmentId, state, threadIds) => {
      const previous = capturedByEnvironment.get(environmentId);
      const next = new Map<ThreadId, CapturedThreadEntry>();
      for (const threadId of threadIds) {
        const messageIds = state.messageIdsByThreadId[threadId];
        const messages = state.messageByThreadId[threadId];
        const cached = previous?.get(threadId);
        if (cached && cached.messageIds === messageIds && cached.messages === messages) {
          next.set(threadId, cached);
          continue;
        }
        const content = captureThreadReadContent(
          (messageIds ?? []).flatMap((messageId) => messages?.[messageId] ?? []),
        );
        next.set(threadId, {
          threadId,
          messageIds,
          messages,
          content,
          entryBytes:
            utf8ByteLength(JSON.stringify(threadId)) + 1 + utf8ByteLength(JSON.stringify(content)),
        });
      }
      capturedByEnvironment.set(environmentId, next);
      return [...next.values()];
    },
    forget: (environmentId) => {
      capturedByEnvironment.delete(environmentId);
    },
    clear: () => {
      capturedByEnvironment.clear();
    },
  };
}

/**
 * The UTF-8 length of a serialized record with its `content` object left
 * out, which is what `trimContentToBudget` takes as `bodyBytes`.
 */
export function measureRecordBodyBytes(recordWithoutContent: object): number {
  // The record's length is this body with an empty `content` plus that
  // object's entries, so the empty object's two bytes are not counted twice.
  return utf8ByteLength(JSON.stringify({ ...recordWithoutContent, content: {} })) - 2;
}

/**
 * The entries a record keeps within `budgetBytes`, dropping from the front
 * (least recently visited) while the record would exceed it. Measured from
 * each entry's own length rather than by re-serializing the whole record once
 * per dropped thread: braces, then the entries and the commas between them.
 */
export function trimContentToBudget<Entry extends { readonly entryBytes: number }>(input: {
  readonly bodyBytes: number;
  readonly entries: ReadonlyArray<Entry>;
  readonly budgetBytes: number;
}): Entry[] {
  const { bodyBytes, entries, budgetBytes } = input;
  let contentBytes =
    2 +
    entries.reduce((total, entry) => total + entry.entryBytes, 0) +
    Math.max(0, entries.length - 1);
  let dropped = 0;
  while (dropped < entries.length && bodyBytes + contentBytes > budgetBytes) {
    contentBytes -= entries[dropped]!.entryBytes + (dropped + 1 < entries.length ? 1 : 0);
    dropped++;
  }
  return entries.slice(dropped);
}

/**
 * The saved display content that is still valid: at most
 * `THREAD_CONTENT_CACHE_DECODE_MAX_CONTENT_ENTRIES` entries, each for a thread
 * the record's own metadata lists and each decoded within the per-thread
 * message and text limits.
 */
export function decodeCachedEnvironmentContent(
  record: { readonly content?: unknown },
  threadIds: ReadonlySet<string>,
): Record<string, CachedThreadContent> {
  const content: Record<string, CachedThreadContent> = {};
  for (const [id, value] of Object.entries(record.content ?? {}).slice(
    0,
    THREAD_CONTENT_CACHE_DECODE_MAX_CONTENT_ENTRIES,
  )) {
    const decoded = decodeThreadReadContent(value);
    if (threadIds.has(id) && decoded) content[id] = decoded;
  }
  return content;
}
