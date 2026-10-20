import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type LocalTask,
  type LocalTaskChange,
  type LocalTaskChangePosition,
  type LocalTaskListInput,
  type LocalTaskListResult,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  selectLocalTasksEnvironment,
  selectLocalTasksForbidden,
  useLocalTasksStore,
} from "./store.ts";
import {
  isLocalTasksRetained,
  LOCAL_TASKS_FORBIDDEN_ERROR,
  LOCAL_TASKS_MAX_PAGES,
  LOCAL_TASKS_PAGE_SIZE,
  LOCAL_TASKS_READ_ERROR,
  LOCAL_TASKS_CHANGE_READ_DELAY_MS,
  LOCAL_TASKS_THREAD_REFRESH_DELAY_MS,
  LOCAL_TASKS_UNSUPPORTED_ERROR,
  refreshLocalTasks,
  retainLocalTasks,
  type LocalTasksApi,
} from "./sync.ts";
import type { LocalTaskThreadSummary } from "./types.ts";

const ENV = EnvironmentId.make("env-tasks-sync");
const THREAD = ThreadId.make("thread-sync");

function task(taskId: string, overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    taskId,
    revision: 1,
    title: `Task ${taskId}`,
    notes: "",
    priority: "normal",
    dueAt: null,
    projectId: null,
    links: [],
    files: [],
    state: "todo",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    status: "todo",
    delegations: [],
    ...overrides,
  };
}

function page(tasks: LocalTask[], nextCursor: string | null = null): LocalTaskListResult {
  return { tasks, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ListFn = (input: LocalTaskListInput) => Promise<LocalTaskListResult>;

function makeApi(list: ListFn | undefined): LocalTasksApi {
  return list ? { listLocalTasks: list } : {};
}

/** A change position of the node's change feed. */
const at = (sequence: number, feed = "feed-1"): LocalTaskChangePosition => ({ feed, sequence });

/** A list page stamped with the node's change position. */
function stamped(
  tasks: LocalTask[],
  position: LocalTaskChangePosition,
  nextCursor: string | null = null,
): LocalTaskListResult {
  return { tasks, nextCursor, position };
}

/** A node with a change stream: `emit` sends a change to the sync's listener. */
function streamApi(list: ListFn) {
  let listener: (change: LocalTaskChange) => void = () => {};
  const unsubscribe = vi.fn();
  const api: LocalTasksApi = {
    listLocalTasks: list,
    getLocalTask: async ({ taskId }) => task(taskId),
    subscribeLocalTaskChanges: (next) => {
      listener = next;
      return unsubscribe;
    },
  };
  return { api, emit: (change: LocalTaskChange) => listener(change), unsubscribe };
}

const environment = () => selectLocalTasksEnvironment(useLocalTasksStore.getState(), ENV);
const taskIds = () => environment().order;
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  vi.useRealTimers();
  await flushMicrotasks();
  useLocalTasksStore.setState({ byEnvironment: {}, forbidden: {} });
});

describe("retainLocalTasks", () => {
  it("reads every page, following the cursor", async () => {
    const list = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(page([task("a")], "a"))
      .mockResolvedValueOnce(page([task("b")], "b"))
      .mockResolvedValueOnce(page([task("c")]));
    const release = retainLocalTasks(makeApi(list), ENV);
    expect(environment().status).toBe("loading");
    await flushMicrotasks();

    expect(list.mock.calls.map(([input]) => input)).toEqual([
      { limit: LOCAL_TASKS_PAGE_SIZE },
      { limit: LOCAL_TASKS_PAGE_SIZE, afterId: "a" },
      { limit: LOCAL_TASKS_PAGE_SIZE, afterId: "b" },
    ]);
    expect(environment()).toMatchObject({ status: "ready", order: ["a", "b", "c"] });
    expect(environment().readAt).not.toBeNull();
    release();
  });

  it("stops after the page cap and keeps the tasks it did not reach", async () => {
    // Ids sort in creation order, so the newest tasks sit past the cap.
    const id = (index: number) => `t${String(index).padStart(4, "0")}`;
    let index = 0;
    const list = vi.fn<ListFn>(async () => {
      index += 1;
      return page([task(id(index))], id(index));
    });
    const release = retainLocalTasks(makeApi(list), ENV);
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(LOCAL_TASKS_MAX_PAGES);
    expect(taskIds()).toHaveLength(LOCAL_TASKS_MAX_PAGES);
    expect(environment().truncated).toBe(true);

    // A task just added here sorts past where the next capped read stops.
    useLocalTasksStore.getState().applyTask(ENV, task("tz-new"));
    index = 0;
    await refreshLocalTasks(ENV);
    expect(taskIds()).toContain("tz-new");
    release();
  });

  it("stops when the cursor stops moving on", async () => {
    const list = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(page([task("a")], "a"))
      .mockResolvedValue(page([task("a")], "a"));
    const release = retainLocalTasks(makeApi(list), ENV);
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(2);
    expect(environment()).toMatchObject({ status: "ready", order: ["a"], truncated: true });
    release();
  });

  it("shares one reader between retainers and clears the tasks on the last release", async () => {
    const list = vi.fn<ListFn>().mockResolvedValue(page([task("a")]));
    const api = makeApi(list);
    const first = retainLocalTasks(api, ENV);
    const second = retainLocalTasks({ ...api }, ENV);
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(1);

    first();
    first();
    await flushMicrotasks();
    expect(isLocalTasksRetained(ENV)).toBe(true);
    expect(taskIds()).toEqual(["a"]);
    second();
    await flushMicrotasks();
    expect(isLocalTasksRetained(ENV)).toBe(false);
    // Memory only: the last release drops the environment's tasks.
    expect(useLocalTasksStore.getState().byEnvironment[ENV]).toBeUndefined();
  });

  it("hands the sync over when a release and a retain land in the same task", async () => {
    const list = vi.fn<ListFn>().mockResolvedValue(page([task("a")]));
    const api = makeApi(list);
    retainLocalTasks(api, ENV)();
    const next = retainLocalTasks(api, ENV);
    await flushMicrotasks();
    expect(isLocalTasksRetained(ENV)).toBe(true);
    expect(environment().status).toBe("ready");
    expect(list).toHaveBeenCalledTimes(1);
    next();
  });

  it("swaps the shared reader when retained through a new connection", async () => {
    const stale = deferred<LocalTaskListResult>();
    const oldList = vi.fn<ListFn>().mockReturnValueOnce(stale.promise);
    const newList = vi.fn<ListFn>().mockResolvedValue(page([task("fresh")]));
    const first = retainLocalTasks(makeApi(oldList), ENV);
    const second = retainLocalTasks(makeApi(newList), ENV);
    stale.resolve(page([task("stale")]));
    await flushMicrotasks();

    expect(taskIds()).toEqual(["fresh"]);
    // Every refresh now goes through the new connection.
    await refreshLocalTasks(ENV);
    expect(oldList).toHaveBeenCalledTimes(1);
    expect(newList).toHaveBeenCalledTimes(2);
    first();
    second();
  });

  it("coalesces refreshes into one trailing read", async () => {
    const reads = [deferred<LocalTaskListResult>(), deferred<LocalTaskListResult>()];
    let index = 0;
    const list = vi.fn<ListFn>(() => reads[index++]!.promise);
    const release = retainLocalTasks(makeApi(list), ENV);
    void refreshLocalTasks(ENV);
    void refreshLocalTasks(ENV);
    expect(list).toHaveBeenCalledTimes(1);
    reads[0]!.resolve(page([task("a")]));
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(2);
    reads[1]!.resolve(page([task("a"), task("b")]));
    await flushMicrotasks();
    expect(taskIds()).toEqual(["a", "b"]);
    release();
  });

  it("keeps a task created while a read was out", async () => {
    const read = deferred<LocalTaskListResult>();
    const release = retainLocalTasks(
      makeApi(vi.fn<ListFn>().mockReturnValueOnce(read.promise)),
      ENV,
    );
    useLocalTasksStore.getState().applyTask(ENV, task("created"));
    read.resolve(page([task("a")]));
    await flushMicrotasks();
    expect(taskIds()).toEqual(["a", "created"]);
    release();
  });

  it("skips a refresh when the last read is fresh enough", async () => {
    const list = vi.fn<ListFn>().mockResolvedValue(page([task("a")]));
    const release = retainLocalTasks(makeApi(list), ENV);
    await flushMicrotasks();
    await refreshLocalTasks(ENV, { staleAfterMs: 60_000 });
    expect(list).toHaveBeenCalledTimes(1);
    await refreshLocalTasks(ENV, { staleAfterMs: 0 });
    expect(list).toHaveBeenCalledTimes(2);
    release();
  });

  it("keeps the last tasks through a failed refresh and reports the error", async () => {
    const list = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(page([task("a")]))
      .mockRejectedValueOnce(new Error("offline"));
    const release = retainLocalTasks(makeApi(list), ENV);
    await flushMicrotasks();
    await refreshLocalTasks(ENV);
    expect(environment()).toMatchObject({ status: "error", error: LOCAL_TASKS_READ_ERROR });
    expect(taskIds()).toEqual(["a"]);
    release();
  });

  it("reports a node without task methods as unsupported", async () => {
    const release = retainLocalTasks(makeApi(undefined), ENV);
    await flushMicrotasks();
    expect(environment()).toMatchObject({
      status: "error",
      error: LOCAL_TASKS_UNSUPPORTED_ERROR,
    });
    release();
  });

  it("reports a node that refuses this session as forbidden, past the release", async () => {
    const refusal = Object.assign(
      new Error("Only owner sessions can call server.listLocalTasks."),
      {
        _tag: "AuthRpcError",
      },
    );
    const release = retainLocalTasks(makeApi(vi.fn<ListFn>().mockRejectedValue(refusal)), ENV);
    await flushMicrotasks();
    expect(environment()).toMatchObject({ status: "error", error: LOCAL_TASKS_FORBIDDEN_ERROR });
    release();
    await flushMicrotasks();
    // Surfaces hide on it and stop reading, so it outlives the read.
    expect(selectLocalTasksForbidden(useLocalTasksStore.getState(), ENV)).toBe(true);

    const again = retainLocalTasks(makeApi(vi.fn<ListFn>().mockResolvedValue(page([]))), ENV);
    await flushMicrotasks();
    expect(selectLocalTasksForbidden(useLocalTasksStore.getState(), ENV)).toBe(false);
    again();
  });

  it("installs refresh triggers once, however many surfaces retain the tasks", async () => {
    const list = vi.fn<ListFn>().mockResolvedValue(page([task("a")]));
    const api = makeApi(list);
    let fire: (options?: { staleAfterMs?: number }) => void = () => {};
    const stop = vi.fn();
    const triggers = vi.fn((refresh: typeof fire) => {
      fire = refresh;
      return stop;
    });
    const first = retainLocalTasks(api, ENV, { triggers });
    const second = retainLocalTasks(api, ENV, { triggers });
    await flushMicrotasks();
    expect(triggers).toHaveBeenCalledTimes(1);

    fire({ staleAfterMs: 60_000 });
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(1);
    fire();
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(2);

    first();
    await flushMicrotasks();
    expect(stop).not.toHaveBeenCalled();
    second();
    await flushMicrotasks();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("re-reads once after a burst of chat state changes", async () => {
    vi.useFakeTimers();
    const delegated = task("a", {
      delegations: [
        {
          commandId: CommandId.make("command-a"),
          threadId: THREAD,
          messageId: MessageId.make("message-a"),
          sequence: 1,
          branch: null,
          dispatched: true,
          status: "running",
          error: null,
          createdAt: "2026-10-18T00:00:00.000Z",
        },
      ],
    });
    const list = vi.fn<ListFn>().mockResolvedValue(page([delegated]));
    let notify = () => {};
    const unsubscribe = vi.fn();
    let hasPendingUserInput = false;
    const summary = (): LocalTaskThreadSummary => ({
      session: null,
      latestTurn: null,
      interactionMode: "default",
      hasPendingApprovals: false,
      hasPendingUserInput,
      hasActionableProposedPlan: false,
      branch: null,
    });
    const release = retainLocalTasks(makeApi(list), ENV, {
      threadActivity: {
        subscribe: (listener) => {
          notify = listener;
          return unsubscribe;
        },
        getSummary: (threadId) => (threadId === THREAD ? summary() : undefined),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);

    // The read itself is the baseline: an unrelated thread-store event reads nothing.
    notify();
    await vi.advanceTimersByTimeAsync(LOCAL_TASKS_THREAD_REFRESH_DELAY_MS);
    expect(list).toHaveBeenCalledTimes(1);

    hasPendingUserInput = true;
    notify();
    hasPendingUserInput = false;
    notify();
    await vi.advanceTimersByTimeAsync(LOCAL_TASKS_THREAD_REFRESH_DELAY_MS - 1);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reads the tasks the node reports changed, and the list once one is gone", async () => {
    vi.useFakeTimers();
    const list = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(page([task("a"), task("b")]))
      .mockResolvedValue(page([task("a", { revision: 2, title: "Renamed by an agent" })]));
    const get = vi.fn((input: { readonly taskId: string }) =>
      input.taskId === "a"
        ? Promise.resolve(task("a", { revision: 2, title: "Renamed by an agent" }))
        : Promise.reject(new Error("Task not found.")),
    );
    let emit: (change: { readonly taskId: string }) => void = () => {};
    const unsubscribe = vi.fn();
    const api: LocalTasksApi = {
      listLocalTasks: list,
      getLocalTask: get as never,
      subscribeLocalTaskChanges: (listener) => {
        emit = listener;
        return unsubscribe;
      },
    };
    const release = retainLocalTasks(api, ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);

    // A burst for one task reads that task once, not the list.
    emit({ taskId: "a" });
    emit({ taskId: "a" });
    await vi.advanceTimersByTimeAsync(LOCAL_TASKS_CHANGE_READ_DELAY_MS);
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(environment().tasks["a"]?.title).toBe("Renamed by an agent");

    // A task that can no longer be read (deleted) re-reads the list, which drops it.
    emit({ taskId: "b" });
    await vi.advanceTimersByTimeAsync(LOCAL_TASKS_CHANGE_READ_DELAY_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    expect(taskIds()).toEqual(["a"]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reads all on the stream's first word, and keeps a deleted task deleted", async () => {
    vi.useFakeTimers();
    const list = vi.fn<ListFn>().mockResolvedValue(page([task("a"), task("b")]));
    let answer: (value: LocalTask) => void = () => {};
    const get = vi.fn(
      () =>
        new Promise<LocalTask>((resolve) => {
          answer = resolve;
        }),
    );
    let emit: (change: { readonly taskId?: string; readonly deleted?: boolean }) => void = () => {};
    const api: LocalTasksApi = {
      listLocalTasks: list,
      getLocalTask: get as never,
      subscribeLocalTaskChanges: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const release = retainLocalTasks(api, ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);

    // Listening now (first, or again after a reconnect): what changed before is read.
    emit({});
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);

    // A deletion drops the task without reading anything.
    emit({ taskId: "b", deleted: true });
    expect(taskIds()).toEqual(["a"]);
    expect(get).not.toHaveBeenCalled();

    // A read still out when the task is deleted here doesn't bring it back.
    emit({ taskId: "a" });
    await vi.advanceTimersByTimeAsync(LOCAL_TASKS_CHANGE_READ_DELAY_MS);
    expect(get).toHaveBeenCalledTimes(1);
    useLocalTasksStore.getState().removeTask(ENV, "a");
    answer(task("a", { revision: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(taskIds()).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reads the list once when the stream starts listening while the first read is out", async () => {
    vi.useFakeTimers();
    const read = deferred<LocalTaskListResult>();
    const list = vi
      .fn<ListFn>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(stamped([task("a")], at(0)));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    expect(list).toHaveBeenCalledTimes(1);

    // The node answers the subscription as the list's first answer comes: nothing changed between.
    emit({ position: at(0) });
    read.resolve(stamped([task("a")], at(0)));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(environment()).toMatchObject({ status: "ready", order: ["a"] });
    release();
  });

  it("reads the list once when the first word comes after the first read landed", async () => {
    vi.useFakeTimers();
    const list = vi.fn<ListFn>().mockResolvedValue(stamped([task("a")], at(0)));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);

    emit({ position: at(0) });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(environment()).toMatchObject({ status: "ready", order: ["a"] });
    release();
  });

  it("reads again when a change came between the read and the word", async () => {
    vi.useFakeTimers();
    // The word comes while the read is out: decided once it lands.
    const read = deferred<LocalTaskListResult>();
    const list = vi
      .fn<ListFn>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(stamped([task("a"), task("b")], at(1)));
    const first = streamApi(list);
    const release = retainLocalTasks(first.api, ENV);
    first.emit({ position: at(1) });
    read.resolve(stamped([task("a")], at(0)));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    expect(taskIds()).toEqual(["a", "b"]);
    release();
    await vi.advanceTimersByTimeAsync(0);

    // The word comes after the read landed: read at once.
    const again = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(stamped([task("a")], at(0)))
      .mockResolvedValue(stamped([task("a"), task("c")], at(1)));
    const second = streamApi(again);
    const next = retainLocalTasks(second.api, ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toHaveBeenCalledTimes(1);
    second.emit({ position: at(1) });
    expect(again).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(taskIds()).toEqual(["a", "c"]);
    next();
  });

  it("reads again on a word from another feed (a restarted node)", async () => {
    vi.useFakeTimers();
    const list = vi.fn<ListFn>().mockResolvedValue(stamped([task("a")], at(4, "feed-1")));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    await vi.advanceTimersByTimeAsync(0);
    emit({ position: at(0, "feed-2") });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    release();
  });

  it("reads on a word without a position, during the first read too", async () => {
    vi.useFakeTimers();
    const read = deferred<LocalTaskListResult>();
    const list = vi
      .fn<ListFn>()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(stamped([task("a")], at(0)));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    // An older node's word says nothing about what it covers.
    emit({});
    read.resolve(stamped([task("a")], at(0)));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    release();
  });

  it("reads on a reconnect's word only when something changed", async () => {
    vi.useFakeTimers();
    const list = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(stamped([task("a")], at(3)))
      .mockResolvedValue(stamped([task("a"), task("b")], at(5)));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    await vi.advanceTimersByTimeAsync(0);

    emit({ position: at(3) });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);

    emit({ position: at(5) });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    expect(taskIds()).toEqual(["a", "b"]);

    emit({ position: at(5) });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    release();
  });

  it("still reads on a word that waited on a failed read", async () => {
    vi.useFakeTimers();
    let fail: (cause: unknown) => void = () => {};
    const list = vi
      .fn<ListFn>()
      .mockReturnValueOnce(
        new Promise<LocalTaskListResult>((_resolve, reject) => {
          fail = reject;
        }),
      )
      .mockResolvedValue(stamped([task("a")], at(0)));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    emit({ position: at(0) });
    fail(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    expect(environment()).toMatchObject({ status: "ready", order: ["a"] });
    release();
  });

  it("takes a read whose pages disagree on the feed as covering nothing", async () => {
    vi.useFakeTimers();
    const list = vi
      .fn<ListFn>()
      .mockResolvedValueOnce(stamped([task("a")], at(0, "feed-1"), "a"))
      .mockResolvedValueOnce(stamped([task("b")], at(0, "feed-2")))
      .mockResolvedValue(stamped([task("a"), task("b")], at(0, "feed-2")));
    const { api, emit } = streamApi(list);
    const release = retainLocalTasks(api, ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);

    emit({ position: at(0, "feed-1") });
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    release();
  });
});
