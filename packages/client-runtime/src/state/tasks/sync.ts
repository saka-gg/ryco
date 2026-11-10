import type {
  EnvironmentApi,
  EnvironmentId,
  LocalTask,
  LocalTaskChangePosition,
} from "@ryco/contracts";

import { isAuthRpcError } from "../../rpc/wsTransport.ts";
import { createSingleFlightReader, type SingleFlightReader } from "../singleFlightReader.ts";
import { delegatedThreadStates, tasksWithMovedChats } from "./logic.ts";
import {
  selectLocalTasksEnvironment,
  selectOpenTaskViews,
  useLocalTasksStore,
  type LocalTasksError,
} from "./store.ts";
import type { LocalTaskThreadSummaryReader } from "./types.ts";

/** The task methods of `EnvironmentApi["server"]`; each is absent on nodes without it. */
export type LocalTasksApi = Pick<
  NonNullable<EnvironmentApi["server"]>,
  | "listLocalTasks"
  | "getLocalTask"
  | "createLocalTask"
  | "updateLocalTask"
  | "deleteLocalTask"
  | "delegateLocalTask"
  | "createLocalTaskFileUpload"
  | "addLocalTaskFile"
  | "removeLocalTaskFile"
  | "subscribeLocalTaskChanges"
>;

export const LOCAL_TASKS_PAGE_SIZE = 100;
/**
 * A safety bound only: a read follows the node's cursor to its last page, and
 * stops here (or when the cursor stops moving on) so a broken cursor cannot
 * page forever. Tasks past where it stopped are kept as they were.
 */
export const LOCAL_TASKS_MAX_PAGES = 200;
/**
 * The window regaining focus re-reads only when the last read is older than
 * this, and only while no live change stream keeps the tasks current.
 */
export const LOCAL_TASKS_FOCUS_REFRESH_MS = 15_000;
/** How long a change in a task chat's live state waits before its tasks are re-read. */
export const LOCAL_TASKS_THREAD_REFRESH_DELAY_MS = 750;
/**
 * How long a new connection waits for its change stream's first word, which
 * says whether anything changed since the last read, before reading the list
 * anyway.
 */
export const LOCAL_TASKS_RECONNECT_WORD_WAIT_MS = 3_000;
/** How long changes the node reports are gathered before the changed tasks are read. */
export const LOCAL_TASKS_CHANGE_READ_DELAY_MS = 200;
/** More changed tasks than this at once are read as one list instead. */
const LOCAL_TASKS_CHANGE_READ_MAX = 10;

export const LOCAL_TASKS_READ_ERROR: LocalTasksError = {
  kind: "read",
  message: "Tasks are unavailable. Check your connection, then refresh.",
};
export const LOCAL_TASKS_UNSUPPORTED_ERROR: LocalTasksError = {
  kind: "unsupported",
  message: "This node doesn't support tasks yet. Update Ryco on it to use them.",
};
export const LOCAL_TASKS_FORBIDDEN_ERROR: LocalTasksError = {
  kind: "forbidden",
  message: "Only the node’s owner can use its tasks.",
};

/** The connected node has no such task method (it predates it). */
export class LocalTasksUnsupportedError extends Error {
  readonly _tag = "LocalTasksUnsupportedError";
  readonly method: keyof LocalTasksApi;

  constructor(method: keyof LocalTasksApi) {
    super(LOCAL_TASKS_UNSUPPORTED_ERROR.message);
    this.method = method;
  }
}

/** A task method of the node, or `LocalTasksUnsupportedError` when it has none. */
export function requireLocalTaskMethod<K extends keyof LocalTasksApi>(
  api: LocalTasksApi,
  method: K,
): NonNullable<LocalTasksApi[K]> {
  const call = api[method];
  if (!call) throw new LocalTasksUnsupportedError(method);
  return call;
}

/**
 * Every task of the node, page by page. `coveredThrough` is the last id read
 * when the read stopped early (see `LOCAL_TASKS_MAX_PAGES`); the node lists
 * ids in ascending order, so the tasks it did not reach sort after it.
 * `position` is the node's change position the read holds every change up
 * to: the first page's, since every later page is queried after it, or null
 * when a page carries none (an older node) or another feed's (the node
 * restarted while paging).
 */
async function readAllLocalTasks(list: NonNullable<LocalTasksApi["listLocalTasks"]>): Promise<{
  readonly tasks: LocalTask[];
  readonly coveredThrough: string | null;
  readonly position: LocalTaskChangePosition | null;
}> {
  const tasks: LocalTask[] = [];
  let afterId: string | undefined;
  let position: LocalTaskChangePosition | null = null;
  for (let page = 1; ; page += 1) {
    const result = await list(
      afterId === undefined
        ? { limit: LOCAL_TASKS_PAGE_SIZE }
        : { limit: LOCAL_TASKS_PAGE_SIZE, afterId },
    );
    tasks.push(...result.tasks);
    if (page === 1) position = result.position ?? null;
    else if (result.position?.feed !== position?.feed) position = null;
    if (result.nextCursor === null) return { tasks, coveredThrough: null, position };
    if (page >= LOCAL_TASKS_MAX_PAGES || (afterId !== undefined && result.nextCursor <= afterId))
      return { tasks, coveredThrough: result.nextCursor, position };
    afterId = result.nextCursor;
  }
}

/** Whether a read stamped at `read` holds every change a read-all word at `word` stands for. */
function positionCovers(
  read: LocalTaskChangePosition | null,
  word: LocalTaskChangePosition,
): boolean {
  return read !== null && read.feed === word.feed && read.sequence >= word.sequence;
}

export interface LocalTasksRefreshOptions {
  /**
   * Skips the read when the last one landed less than this many ms ago, and
   * while a live change stream keeps the tasks current (see `catchUp`).
   */
  readonly staleAfterMs?: number;
  /**
   * The read only catches up on changes that may have been missed (the same
   * connection coming back): skipped while the node's change stream is live,
   * since the stream's word after a drop reads exactly when something changed.
   */
  readonly catchUp?: boolean;
}

/**
 * Platform signals that should re-read the tasks (e.g. the window regaining
 * focus, with `staleAfterMs: LOCAL_TASKS_FOCUS_REFRESH_MS`); returns its
 * unsubscribe.
 */
export type LocalTasksRefreshTriggers = (
  refresh: (options?: LocalTasksRefreshOptions) => void,
) => () => void;

/** The live thread store of the tasks' environment. */
export interface LocalTasksThreadActivitySource {
  /** Calls `listener` after every change of the thread store; returns its unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSummary: LocalTaskThreadSummaryReader;
}

export interface LocalTasksRetainOptions {
  readonly triggers?: LocalTasksRefreshTriggers;
  /**
   * When given, a chat of an open task moving between states (see
   * `delegatedThreadStates`) re-reads the tasks it belongs to once the moves
   * settle, so the node's status follows the chats without polling.
   */
  readonly threadActivity?: LocalTasksThreadActivitySource;
}

interface ThreadWatch {
  /** Takes the current chat states as read, so only later moves re-read. */
  readonly rebase: () => void;
  readonly stop: () => void;
}

interface ChangeWatch {
  /**
   * The stream delivered on this connection and has not failed: it reports
   * every change, and after a drop it starts again with a word that reads
   * whatever the drop missed.
   */
  readonly live: () => boolean;
  readonly stop: () => void;
}

interface RetainedTasks {
  count: number;
  api: LocalTasksApi;
  reader: SingleFlightReader;
  teardownScheduled: boolean;
  /** Installed once per retained environment, however many surfaces share it. */
  stopTriggers: (() => void) | null;
  threadWatch: ThreadWatch | null;
  /** The node's change stream on the current connection, while it has one. */
  changes: ChangeWatch | null;
  /**
   * The change position the last landed read holds every change up to, when
   * known. A position names the node process's feed, so it stays comparable
   * across connections to the same node.
   */
  covered: LocalTaskChangePosition | null;
  /** A new connection waits for its stream's first word instead of reading at once. */
  reconnectWait: ReturnType<typeof setTimeout> | null;
  /** A read is out on the current reader. */
  reading: boolean;
  /** A read-all word that came while a read was out; decided once that read lands. */
  deferredReadAll: LocalTaskChangePosition | null;
}

const retained = new Map<EnvironmentId, RetainedTasks>();

interface ReaderHooks {
  /** A read goes out. */
  readonly started: () => void;
  /** A read landed and was applied, holding every change up to `position` when known. */
  readonly landed: (position: LocalTaskChangePosition | null) => void;
  readonly failed: () => void;
}

function startReader(
  environmentId: EnvironmentId,
  api: LocalTasksApi,
  hooks: ReaderHooks,
): SingleFlightReader {
  return createSingleFlightReader({
    read: async () => {
      hooks.started();
      const list = requireLocalTaskMethod(api, "listLocalTasks");
      // Recorded before the first page goes out: anything applied after
      // this is newer than the read.
      const since = selectLocalTasksEnvironment(
        useLocalTasksStore.getState(),
        environmentId,
      ).writeEpoch;
      return { ...(await readAllLocalTasks(list)), since };
    },
    onValue: ({ tasks, coveredThrough, position, since }) => {
      useLocalTasksStore
        .getState()
        .applyList(environmentId, tasks, { since, readAt: Date.now(), coveredThrough });
      hooks.landed(position);
    },
    onError: (cause) => {
      useLocalTasksStore
        .getState()
        .setError(
          environmentId,
          cause instanceof LocalTasksUnsupportedError
            ? LOCAL_TASKS_UNSUPPORTED_ERROR
            : isAuthRpcError(cause)
              ? LOCAL_TASKS_FORBIDDEN_ERROR
              : LOCAL_TASKS_READ_ERROR,
        );
      hooks.failed();
    },
  });
}

/**
 * What a retained environment's reader tells the sync about its reads: what
 * the last landed read covers, and whether a read is out. A read-all word
 * that waited on the read is decided once it lands, and read anyway when it
 * failed. `entryOf` is read on every call, so the hooks can be made before
 * the entry they belong to.
 */
function readerHooks(environmentId: EnvironmentId, entryOf: () => RetainedTasks): ReaderHooks {
  const takeDeferred = (held: RetainedTasks) => {
    const word = held.deferredReadAll;
    held.deferredReadAll = null;
    return word;
  };
  return {
    started: () => {
      entryOf().reading = true;
    },
    landed: (position) => {
      const held = entryOf();
      held.reading = false;
      held.covered = position;
      held.threadWatch?.rebase();
      const word = takeDeferred(held);
      // Read from inside the landing read: the reader reads once more after it.
      if (word !== null && !positionCovers(position, word)) void refreshEntry(environmentId, held);
    },
    failed: () => {
      const held = entryOf();
      held.reading = false;
      if (takeDeferred(held) !== null) void refreshEntry(environmentId, held);
    },
  };
}

function refreshEntry(
  environmentId: EnvironmentId,
  entry: RetainedTasks,
  options?: LocalTasksRefreshOptions,
): Promise<void> {
  const store = useLocalTasksStore.getState();
  const environment = selectLocalTasksEnvironment(store, environmentId);
  // A first read still loading is as fresh as it gets.
  if (
    options?.staleAfterMs !== undefined &&
    (environment.status === "loading" ||
      (environment.readAt !== null && Date.now() - environment.readAt < options.staleAfterMs))
  )
    return Promise.resolve();
  // The change stream keeps a landed list current; a read on a hunch adds nothing.
  if (
    (options?.staleAfterMs !== undefined || options?.catchUp === true) &&
    environment.status === "ready" &&
    entry.changes?.live() === true
  )
    return Promise.resolve();
  if (environment.status !== "ready") store.setLoading(environmentId);
  return entry.reader.refresh();
}

function watchThreads(
  environmentId: EnvironmentId,
  source: LocalTasksThreadActivitySource,
  readTasks: (taskIds: ReadonlyArray<string>) => void,
): ThreadWatch {
  const statesNow = () =>
    delegatedThreadStates(
      selectOpenTaskViews(useLocalTasksStore.getState(), environmentId),
      source.getSummary,
    );
  let last = statesNow();
  const moved = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = source.subscribe(() => {
    const next = statesNow();
    for (const taskId of tasksWithMovedChats(last, next)) moved.add(taskId);
    last = next;
    // One read per burst of moves, at most a delay after the first of them.
    if (moved.size === 0 || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const taskIds = [...moved];
      moved.clear();
      readTasks(taskIds);
    }, LOCAL_TASKS_THREAD_REFRESH_DELAY_MS);
  });
  return {
    rebase: () => {
      last = statesNow();
    },
    stop: () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      moved.clear();
    },
  };
}

/**
 * Reads the named tasks one by one (`getLocalTask`), or the whole list when
 * the node has no such method or there are too many of them. A task that
 * cannot be read (deleted) reads the list. `isCurrent` says whether the read
 * still belongs to the retained connection.
 */
function readChangedTasks(
  environmentId: EnvironmentId,
  api: LocalTasksApi,
  taskIds: ReadonlyArray<string>,
  isCurrent: () => boolean,
  refresh: () => void,
): void {
  if (taskIds.length === 0 || !isCurrent()) return;
  const get = api.getLocalTask;
  if (!get || taskIds.length > LOCAL_TASKS_CHANGE_READ_MAX) {
    refresh();
    return;
  }
  const known = selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).tasks;
  for (const taskId of taskIds) {
    // Deleted here while the read was out (its change may come after): it stays deleted.
    const wasKnown = taskId in known;
    get({ taskId }).then(
      (task) => {
        if (!isCurrent()) return;
        const store = useLocalTasksStore.getState();
        if (wasKnown && !(taskId in selectLocalTasksEnvironment(store, environmentId).tasks))
          return;
        store.applyTask(environmentId, task);
      },
      // Deleted, or unreadable now: the list says what is left.
      () => {
        if (isCurrent()) refresh();
      },
    );
  }
}

/**
 * Follows the node's task changes (another client, an agent through Agent
 * Control): each burst reads the tasks it names, and a task that cannot be
 * read (deleted) or a large burst reads the whole list. The word to read
 * every task goes to `readAll` with the position it covers; the stream
 * stopping for good goes to `failed`. `isCurrent` says whether the read
 * still belongs to the retained connection.
 */
function watchChanges(
  environmentId: EnvironmentId,
  api: LocalTasksApi,
  isCurrent: () => boolean,
  refresh: () => void,
  readAll: (position: LocalTaskChangePosition | undefined) => void,
  failed: () => void,
): ChangeWatch | null {
  const subscribe = api.subscribeLocalTaskChanges;
  if (!subscribe) return null;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delivered = false;
  let stopped = false;
  const flush = () => {
    timer = null;
    const taskIds = [...pending];
    pending.clear();
    readChangedTasks(environmentId, api, taskIds, isCurrent, refresh);
  };
  const unsubscribe = subscribe(
    (change) => {
      if (!isCurrent()) return;
      delivered = true;
      // The stream's first word, once it listens (again, after a reconnect), or in place of
      // changes it fell too far behind on: read everything a read already out or landed misses.
      if (change.taskId === undefined) {
        readAll(change.position);
        return;
      }
      if (change.deleted) {
        pending.delete(change.taskId);
        useLocalTasksStore.getState().removeTask(environmentId, change.taskId);
        return;
      }
      pending.add(change.taskId);
      if (timer === null) timer = setTimeout(flush, LOCAL_TASKS_CHANGE_READ_DELAY_MS);
    },
    {
      onError: () => {
        stopped = true;
        if (isCurrent()) failed();
      },
    },
  );
  return {
    live: () => delivered && !stopped,
    stop: () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function clearReconnectWait(entry: RetainedTasks): void {
  if (entry.reconnectWait !== null) clearTimeout(entry.reconnectWait);
  entry.reconnectWait = null;
}

/**
 * Keeps one environment's tasks in `useLocalTasksStore` while retained. Every
 * surface showing them (the Tasks page, the sidebar badge) shares one reader,
 * which reads every page when it starts; retaining with a new connection's
 * `api` swaps the reader for all of them and reads again, or, when a landed
 * read holds a change position, waits for the new change stream's first word
 * and reads only if something changed since. The last release stops at the
 * end of the task, so an effect re-running hands the sync over
 * instead of dropping the tasks. Changes the node reports on its change stream
 * are read as they come (`watchChanges`); the stream's word to read every task
 * reads the list only when no read already covers its position (one that
 * landed, or the one out, decided once it lands). The first retainer's
 * `triggers` and `threadActivity` are installed once: a trigger re-reads the
 * list (unless the change stream is live and the read optional, see
 * `LocalTasksRefreshOptions`), a chat moving reads the tasks it belongs to.
 * A node without `listLocalTasks` leaves the environment in `error` with
 * `LOCAL_TASKS_UNSUPPORTED_ERROR`. Returns the (idempotent) release.
 */
export function retainLocalTasks(
  api: LocalTasksApi,
  environmentId: EnvironmentId,
  options: LocalTasksRetainOptions = {},
): () => void {
  let entry = retained.get(environmentId);
  // Platforms rebuild the api object on every lookup; a new connection is
  // told apart by its methods instead.
  const fresh = !entry || entry.api.listLocalTasks !== api.listLocalTasks;
  if (!entry) {
    const created: RetainedTasks = {
      count: 0,
      api,
      reader: startReader(
        environmentId,
        api,
        readerHooks(environmentId, () => created),
      ),
      teardownScheduled: false,
      stopTriggers: null,
      threadWatch: null,
      changes: null,
      covered: null,
      reconnectWait: null,
      reading: false,
      deferredReadAll: null,
    };
    entry = created;
    retained.set(environmentId, created);
  } else if (fresh) {
    const swapped = entry;
    swapped.reader.stop();
    // `covered` stays: its feed tells whether the new connection's words reach the same node
    // process. Only the read that was out is gone.
    swapped.reading = false;
    swapped.deferredReadAll = null;
    swapped.reader = startReader(
      environmentId,
      api,
      readerHooks(environmentId, () => swapped),
    );
  }
  entry.api = api;
  entry.count += 1;
  const held = entry;

  const refresh = (refreshOptions?: LocalTasksRefreshOptions) =>
    void refreshEntry(environmentId, held, refreshOptions);
  const readAll = (position: LocalTaskChangePosition | undefined) => {
    // The word a new connection waited for has come: it decides.
    clearReconnectWait(held);
    if (position !== undefined) {
      // A read stamped at or past the word already holds what it stands for.
      if (positionCovers(held.covered, position)) return;
      // The read out may: decide once it lands.
      if (held.reading) {
        held.deferredReadAll = position;
        return;
      }
    }
    refresh();
  };
  const currentConnection = () => {
    const listing = held.api.listLocalTasks;
    return () => retained.get(environmentId) === held && held.api.listLocalTasks === listing;
  };
  // A new connection to a node whose positions a landed read holds: the stream's first word
  // says whether anything changed meanwhile, so the list is read only then (or when the word
  // does not come).
  let awaitWord = false;
  if (fresh) {
    held.changes?.stop();
    held.changes = null;
    clearReconnectWait(held);
    awaitWord =
      api.subscribeLocalTaskChanges !== undefined &&
      held.covered !== null &&
      selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).status === "ready";
    const isCurrent = currentConnection();
    if (awaitWord)
      held.reconnectWait = setTimeout(() => {
        held.reconnectWait = null;
        if (isCurrent()) refresh();
      }, LOCAL_TASKS_RECONNECT_WORD_WAIT_MS);
    held.changes = watchChanges(
      environmentId,
      api,
      isCurrent,
      () => refresh(),
      readAll,
      () => {
        // Waiting for a word that will not come: read now.
        if (held.reconnectWait === null) return;
        clearReconnectWait(held);
        refresh();
      },
    );
  }
  if (options.triggers && held.stopTriggers === null) held.stopTriggers = options.triggers(refresh);
  if (options.threadActivity && held.threadWatch === null)
    held.threadWatch = watchThreads(environmentId, options.threadActivity, (taskIds) =>
      readChangedTasks(environmentId, held.api, taskIds, currentConnection(), () => refresh()),
    );
  if (fresh && !awaitWord) refresh();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count > 0 || held.teardownScheduled) return;
    held.teardownScheduled = true;
    void Promise.resolve().then(() => {
      held.teardownScheduled = false;
      if (held.count > 0 || retained.get(environmentId) !== held) return;
      retained.delete(environmentId);
      held.reader.stop();
      held.stopTriggers?.();
      held.threadWatch?.stop();
      held.changes?.stop();
      clearReconnectWait(held);
      useLocalTasksStore.getState().clear(environmentId);
    });
  };
}

/**
 * Re-reads a retained environment's tasks; concurrent calls share one read.
 * Resolves at once when nothing retains the environment.
 */
export function refreshLocalTasks(
  environmentId: EnvironmentId,
  options?: LocalTasksRefreshOptions,
): Promise<void> {
  const entry = retained.get(environmentId);
  return entry ? refreshEntry(environmentId, entry, options) : Promise.resolve();
}

/** Test-only: whether an environment's task sync is currently held. */
export function isLocalTasksRetained(environmentId: EnvironmentId): boolean {
  return retained.has(environmentId);
}
