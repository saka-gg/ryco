import type {
  EnvironmentApi,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
} from "@ryco/contracts";

/**
 * Reads a thread's whole retained history from its node at one projection sequence: a window,
 * then every older page of the chosen collections, then one more window that must still be at
 * the same sequence. Used by the conversation export and by "Continue on another machine"
 * (`state/threads/carriedFork.ts`); each caller projects and bounds the items it keeps.
 *
 * Reads only: no UI-store mutation, no provider call, nothing written on the node.
 */

/** The collections a reader can page. */
export type ThreadHistoryCollection = "messages" | "activities" | "proposedPlans";

export type ThreadHistoryItem =
  | { readonly collection: "messages"; readonly item: OrchestrationMessage }
  | { readonly collection: "activities"; readonly item: OrchestrationThreadActivity }
  | { readonly collection: "proposedPlans"; readonly item: OrchestrationProposedPlan };

/** What each failure says; every caller words them for its own action. */
export interface ThreadHistoryCopy {
  readonly cancelled: string;
  /** The conversation or the connection changed while it was read. */
  readonly changed: string;
  readonly timedOut: string;
  /** The node cannot page its history. */
  readonly unsupported: string;
  readonly stalled: string;
  readonly overlapping: (collection: ThreadHistoryCollection) => string;
  readonly emptyPage: string;
}

/** How long one history request may take. */
export const THREAD_HISTORY_REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;

export async function collectThreadHistory<Thread>(input: {
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly signal: AbortSignal;
  /** False once the connection the read started on is gone: the read stops. */
  readonly isCurrent: () => boolean;
  readonly collections: ReadonlyArray<ThreadHistoryCollection>;
  readonly copy: ThreadHistoryCopy;
  /** The first window's thread, once: the metadata the caller keeps (or a bound it checks). */
  readonly project: (thread: OrchestrationThread) => Thread;
  /** Every item of the chosen collections, once, newest window first; throws to stop. */
  readonly onItem: (entry: ThreadHistoryItem) => void;
  /** Every page cursor, before its page is asked for; throws to stop. */
  readonly onCursor?: (cursor: string) => void;
}): Promise<Thread> {
  const { copy } = input;
  const check = () => {
    if (input.signal.aborted) throw new Error(copy.cancelled);
    if (!input.isCurrent()) throw new Error(copy.changed);
  };
  const request = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => finish(() => reject(new Error(copy.cancelled)));
      const timer = setTimeout(
        () => finish(() => reject(new Error(copy.timedOut))),
        THREAD_HISTORY_REQUEST_TIMEOUT_MS,
      );
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        settle();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (input.signal.aborted) abort();
    });
  const { getThreadWindow, getThreadHistoryPage } = input.api.orchestration;
  if (!getThreadWindow || !getThreadHistoryPage) throw new Error(copy.unsupported);
  const wanted = new Set(input.collections);
  const limits = {
    messages: wanted.has("messages") ? PAGE_LIMIT : 1,
    activities: wanted.has("activities") ? PAGE_LIMIT : 1,
    proposedPlans: wanted.has("proposedPlans") ? PAGE_LIMIT : 1,
    checkpoints: 1,
  };
  check();
  const window = await request(getThreadWindow({ threadId: input.threadId, limits }));
  check();
  if (window.thread.id !== input.threadId) throw new Error(copy.changed);
  const thread = input.project(window.thread);
  const seen: Record<ThreadHistoryCollection, Set<string>> = {
    messages: new Set(),
    activities: new Set(),
    proposedPlans: new Set(),
  };
  const add = (entry: ThreadHistoryItem) => {
    const ids = seen[entry.collection];
    if (ids.has(entry.item.id)) throw new Error(copy.overlapping(entry.collection));
    ids.add(entry.item.id);
    input.onItem(entry);
  };
  const addAll = (collection: ThreadHistoryCollection, items: ReadonlyArray<unknown>) => {
    for (const item of items) add({ collection, item } as ThreadHistoryItem);
  };
  for (const collection of input.collections) addAll(collection, window.thread[collection]);
  for (const collection of input.collections) {
    let page = window.history[collection];
    const cursors = new Set<string>();
    while (page.hasMoreBefore) {
      check();
      const cursor = page.oldestCursor;
      if (!cursor || cursors.has(cursor)) throw new Error(copy.stalled);
      input.onCursor?.(cursor);
      cursors.add(cursor);
      const result = await request(
        getThreadHistoryPage({
          threadId: input.threadId,
          collection,
          mode: { kind: "before", cursor },
          limit: PAGE_LIMIT,
        }),
      );
      check();
      if (result.snapshotSequence !== window.snapshotSequence || result.collection !== collection)
        throw new Error(copy.changed);
      if (result.page.oldestCursor && cursors.has(result.page.oldestCursor))
        throw new Error(copy.stalled);
      if (!result.items.length) throw new Error(copy.emptyPage);
      addAll(collection, result.items);
      page = result.page;
    }
  }
  const final = await request(
    getThreadWindow({
      threadId: input.threadId,
      limits: { messages: 1, activities: 1, proposedPlans: 1, checkpoints: 1 },
    }),
  );
  check();
  if (final.thread.id !== input.threadId || final.snapshotSequence !== window.snapshotSequence)
    throw new Error(copy.changed);
  return thread;
}
