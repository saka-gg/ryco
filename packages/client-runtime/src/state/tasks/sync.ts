import type { EnvironmentApi, EnvironmentId, LocalTask } from "@ryco/contracts";

import { createSingleFlightReader, type SingleFlightReader } from "../singleFlightReader.ts";
import { delegatedThreadSignature } from "./logic.ts";
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
/** The window regaining focus re-reads only when the last read is older than this. */
export const LOCAL_TASKS_FOCUS_REFRESH_MS = 15_000;
/** How long a change in a task chat's live state waits before the tasks are re-read. */
export const LOCAL_TASKS_THREAD_REFRESH_DELAY_MS = 750;
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

/**
 * The node refused the call to this session (an `AuthRpcError`: the task
 * methods are owner-only). Read by tag, so the contracts root stays out of
 * this package's value imports.
 */
function isAuthRpcError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "AuthRpcError"
  );
}

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
 */
async function readAllLocalTasks(
  list: NonNullable<LocalTasksApi["listLocalTasks"]>,
): Promise<{ readonly tasks: LocalTask[]; readonly coveredThrough: string | null }> {
  const tasks: LocalTask[] = [];
  let afterId: string | undefined;
  for (let page = 1; ; page += 1) {
    const result = await list(
      afterId === undefined
        ? { limit: LOCAL_TASKS_PAGE_SIZE }
        : { limit: LOCAL_TASKS_PAGE_SIZE, afterId },
    );
    tasks.push(...result.tasks);
    if (result.nextCursor === null) return { tasks, coveredThrough: null };
    if (page >= LOCAL_TASKS_MAX_PAGES || (afterId !== undefined && result.nextCursor <= afterId))
      return { tasks, coveredThrough: result.nextCursor };
    afterId = result.nextCursor;
  }
}

export interface LocalTasksRefreshOptions {
  /** Skips the read when the last one landed less than this many ms ago. */
  readonly staleAfterMs?: number;
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
   * `delegatedThreadSignature`) re-reads the tasks once the moves settle, so
   * the node's status follows the chats without polling.
   */
  readonly threadActivity?: LocalTasksThreadActivitySource;
}

interface ThreadWatch {
  /** Takes the current chat states as read, so only later moves re-read. */
  readonly rebase: () => void;
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
  stopChanges: (() => void) | null;
}

const retained = new Map<EnvironmentId, RetainedTasks>();

function startReader(
  environmentId: EnvironmentId,
  api: LocalTasksApi,
  afterRead: () => void,
): SingleFlightReader {
  return createSingleFlightReader({
    read: async () => {
      const list = requireLocalTaskMethod(api, "listLocalTasks");
      // Recorded before the first page goes out: anything applied after
      // this is newer than the read.
      const since = selectLocalTasksEnvironment(
        useLocalTasksStore.getState(),
        environmentId,
      ).writeEpoch;
      return { ...(await readAllLocalTasks(list)), since };
    },
    onValue: ({ tasks, coveredThrough, since }) => {
      useLocalTasksStore
        .getState()
        .applyList(environmentId, tasks, { since, readAt: Date.now(), coveredThrough });
      afterRead();
    },
    onError: (cause) =>
      useLocalTasksStore
        .getState()
        .setError(
          environmentId,
          cause instanceof LocalTasksUnsupportedError
            ? LOCAL_TASKS_UNSUPPORTED_ERROR
            : isAuthRpcError(cause)
              ? LOCAL_TASKS_FORBIDDEN_ERROR
              : LOCAL_TASKS_READ_ERROR,
        ),
  });
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
  if (environment.status !== "ready") store.setLoading(environmentId);
  return entry.reader.refresh();
}

function watchThreads(
  environmentId: EnvironmentId,
  source: LocalTasksThreadActivitySource,
  refresh: () => void,
): ThreadWatch {
  const signatureNow = () =>
    delegatedThreadSignature(
      selectOpenTaskViews(useLocalTasksStore.getState(), environmentId),
      source.getSummary,
    );
  let last = signatureNow();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = source.subscribe(() => {
    const next = signatureNow();
    if (next === last) return;
    last = next;
    // One read per burst of moves, at most a delay after the first of them.
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, LOCAL_TASKS_THREAD_REFRESH_DELAY_MS);
  });
  return {
    rebase: () => {
      last = signatureNow();
    },
    stop: () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Follows the node's task changes (another client, an agent through Agent
 * Control): each burst reads the tasks it names, and a task that cannot be
 * read (deleted) or a large burst reads the whole list. `isCurrent` says
 * whether the read still belongs to the retained connection.
 */
function watchChanges(
  environmentId: EnvironmentId,
  api: LocalTasksApi,
  isCurrent: () => boolean,
  refresh: () => void,
): (() => void) | null {
  const subscribe = api.subscribeLocalTaskChanges;
  if (!subscribe) return null;
  const get = api.getLocalTask;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const taskIds = [...pending];
    pending.clear();
    if (!isCurrent()) return;
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
  };
  const unsubscribe = subscribe((change) => {
    if (!isCurrent()) return;
    // The stream's first word, once it listens (again, after a reconnect): read everything.
    if (change.taskId === undefined) {
      refresh();
      return;
    }
    if (change.deleted) {
      pending.delete(change.taskId);
      useLocalTasksStore.getState().removeTask(environmentId, change.taskId);
      return;
    }
    pending.add(change.taskId);
    if (timer === null) timer = setTimeout(flush, LOCAL_TASKS_CHANGE_READ_DELAY_MS);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Keeps one environment's tasks in `useLocalTasksStore` while retained. Every
 * surface showing them (the Tasks page, the sidebar badge) shares one reader,
 * which reads every page when it starts; retaining with a new connection's
 * `api` swaps the reader for all of them and reads again. The last release
 * stops at the end of the task, so an effect re-running hands the sync over
 * instead of dropping the tasks. Changes the node reports on its change stream
 * are read as they come (`watchChanges`). The first retainer's `triggers` and
 * `threadActivity` are installed once and re-read once per signal. A node
 * without `listLocalTasks` leaves the environment in `error` with
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
      reader: startReader(environmentId, api, () => created.threadWatch?.rebase()),
      teardownScheduled: false,
      stopTriggers: null,
      threadWatch: null,
      stopChanges: null,
    };
    entry = created;
    retained.set(environmentId, created);
  } else if (fresh) {
    const swapped = entry;
    swapped.reader.stop();
    swapped.reader = startReader(environmentId, api, () => swapped.threadWatch?.rebase());
  }
  entry.api = api;
  entry.count += 1;
  const held = entry;

  const refresh = (refreshOptions?: LocalTasksRefreshOptions) =>
    void refreshEntry(environmentId, held, refreshOptions);
  if (fresh) {
    held.stopChanges?.();
    const listing = api.listLocalTasks;
    held.stopChanges = watchChanges(
      environmentId,
      api,
      () => retained.get(environmentId) === held && held.api.listLocalTasks === listing,
      () => refresh(),
    );
  }
  if (options.triggers && held.stopTriggers === null) held.stopTriggers = options.triggers(refresh);
  if (options.threadActivity && held.threadWatch === null)
    held.threadWatch = watchThreads(environmentId, options.threadActivity, () => refresh());
  if (fresh) refresh();

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
      held.stopChanges?.();
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
