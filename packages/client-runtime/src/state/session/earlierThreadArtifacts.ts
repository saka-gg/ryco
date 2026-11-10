import type {
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationThreadHistoryCursor,
  OrchestrationThreadHistoryPage,
  ThreadId,
} from "@ryco/contracts";
import { LRUCache } from "@ryco/shared/lruCache";

import { readMessageArtifacts, type ThreadArtifactSource } from "./threadArtifacts.ts";

/**
 * A thread's artifacts further back than the thread as loaded, read on their
 * own: only the messages that carry them, beside the thread store and never
 * merged into it, so the timeline's window and paging stay exactly as they are.
 * Shared by web's Artifacts panel and the phone's artifacts sheet.
 */

export type ReadArtifactHistoryPage = (
  input: OrchestrationGetThreadHistoryPageInput,
) => Promise<OrchestrationThreadHistoryPage>;

/** Artifact messages per page; each page carries its pages' thumbnails. */
export const ARTIFACT_HISTORY_PAGE_LIMIT = 30;
// An older environment ignores the filter and pages every message; a read
// goes on through pages without artifacts, this far, before it reports back.
const MAX_PAGES_PER_READ = 5;

export interface EarlierArtifactMessages {
  /** The messages read that carry artifacts. */
  readonly messages: ReadonlyArray<ThreadArtifactSource>;
  /** Where the next read starts, or null at the start of the thread. */
  readonly cursor: OrchestrationThreadHistoryCursor | null;
}

/** Reads the artifact messages before `cursor`, until it has some or reaches the start. */
export async function readEarlierArtifactMessages(
  readPage: ReadArtifactHistoryPage,
  threadId: ThreadId,
  cursor: OrchestrationThreadHistoryCursor,
): Promise<EarlierArtifactMessages> {
  const messages: ThreadArtifactSource[] = [];
  let next: OrchestrationThreadHistoryCursor | null = cursor;
  for (let read = 0; read < MAX_PAGES_PER_READ && next !== null; read += 1) {
    const page: OrchestrationThreadHistoryPage = await readPage({
      threadId,
      collection: "messages",
      mode: { kind: "before", cursor: next },
      limit: ARTIFACT_HISTORY_PAGE_LIMIT,
      messageFilter: "artifacts",
    });
    if (page.collection !== "messages") return { messages, cursor: null };
    messages.push(...page.items.filter((message) => readMessageArtifacts(message).length > 0));
    next = page.page.hasMoreBefore ? page.page.oldestCursor : null;
    if (messages.length > 0) break;
  }
  return { messages, cursor: next };
}

/**
 * Remembers what was read further back, keyed by where the thread as loaded
 * begins: a timeline that pages further back, or a window that starts over,
 * begins somewhere else, and the read starts over from there. A remount reads
 * nothing it already has, and two readers of one thread share one read.
 */
export interface EarlierArtifactReads {
  /** What was read from `identity` so far, or null. */
  readonly cached: (identity: string) => EarlierArtifactMessages | null;
  /**
   * Reads on from `cursor` (the end of `read`, or where the thread as loaded
   * begins) and remembers the combined result under `identity`.
   */
  readonly readFrom: (input: {
    readonly identity: string;
    readonly threadId: ThreadId;
    readonly read: EarlierArtifactMessages | null;
    readonly cursor: OrchestrationThreadHistoryCursor;
    /** The environment's history read right now; undefined while it is not connected. */
    readonly readPage: () => ReadArtifactHistoryPage | undefined;
  }) => Promise<EarlierArtifactMessages>;
  readonly clear: () => void;
}

/** `identity` for `createEarlierArtifactReads`: empty when there is nothing further back. */
export function earlierArtifactReadIdentity(
  environmentId: string | null,
  threadId: string | null,
  startCursor: OrchestrationThreadHistoryCursor | null,
): string {
  return environmentId && threadId && startCursor
    ? `${environmentId}:${threadId}:${startCursor}`
    : "";
}

export function createEarlierArtifactReads(maxThreads = 32): EarlierArtifactReads {
  const readByStart = new LRUCache<EarlierArtifactMessages>(maxThreads, Number.POSITIVE_INFINITY);
  const inflight = new Map<string, Promise<EarlierArtifactMessages>>();
  return {
    cached: (identity) => (identity ? readByStart.get(identity) : null),
    readFrom: ({ identity, threadId, read, cursor, readPage }) => {
      const key = `${identity}:${cursor}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const request = Promise.resolve()
        .then(() => {
          const readHistory = readPage();
          // Not connected (yet): asked again once a connection opens.
          if (!readHistory)
            throw new Error("The environment cannot read thread history right now.");
          return readEarlierArtifactMessages(readHistory, threadId, cursor);
        })
        .then((page) => {
          const next = {
            messages: [...(read?.messages ?? []), ...page.messages],
            cursor: page.cursor,
          };
          readByStart.set(identity, next, 1);
          return next;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },
    clear: () => {
      readByStart.clear();
      inflight.clear();
    },
  };
}
