import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type LocalTask,
  type LocalTaskDelegation,
} from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  EMPTY_LOCAL_TASKS_STATE,
  selectLocalTasksEnvironment,
  selectOpenTaskViews,
  selectTaskIds,
  selectTaskView,
  useLocalTasksStore,
} from "./store.ts";
import type { LocalTaskOptimisticStart } from "./types.ts";

const ENV = EnvironmentId.make("env-tasks-store");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

function task(taskId: string, overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    taskId,
    revision: 1,
    title: `Task ${taskId}`,
    notes: "",
    priority: "normal",
    dueAt: null,
    projectId: PROJECT_A,
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

function delegation(
  name: string,
  sequence: number,
  status: LocalTaskDelegation["status"] = "running",
): LocalTaskDelegation {
  return {
    commandId: CommandId.make(`command-${name}`),
    threadId: ThreadId.make(`thread-${name}`),
    messageId: MessageId.make(`message-${name}`),
    sequence,
    branch: null,
    dispatched: true,
    status,
    error: null,
    createdAt: "2026-10-18T00:00:00.000Z",
  };
}

function optimisticStart(name: string): LocalTaskOptimisticStart {
  return {
    commandId: CommandId.make(`command-${name}`),
    threadId: ThreadId.make(`thread-${name}`),
    status: "starting",
    branch: "task/x",
    createdAt: "2026-10-18T00:00:00.000Z",
  };
}

const store = () => useLocalTasksStore.getState();
const environment = () => selectLocalTasksEnvironment(store(), ENV);
const epoch = () => environment().writeEpoch;
const view = (taskId: string) => selectTaskView(store(), ENV, taskId);

afterEach(() => {
  useLocalTasksStore.setState({ byEnvironment: {} });
});

describe("applyList", () => {
  it("publishes a read in list order", () => {
    store().setLoading(ENV);
    expect(environment().status).toBe("loading");
    store().applyList(ENV, [task("a"), task("b")], { since: epoch(), readAt: 42 });
    expect(environment()).toMatchObject({
      status: "ready",
      error: null,
      readAt: 42,
      order: ["a", "b"],
    });
  });

  it("keeps the task objects of an unchanged re-read", () => {
    store().applyList(ENV, [task("a"), task("b")], { since: epoch(), readAt: 1 });
    const before = environment();
    store().applyList(ENV, [task("a"), task("b")], { since: epoch(), readAt: 2 });
    expect(environment().tasks).toBe(before.tasks);
    expect(environment().order).toBe(before.order);
  });

  it("drops tasks the node no longer lists", () => {
    store().applyList(ENV, [task("a"), task("b")], { since: epoch(), readAt: 1 });
    store().applyList(ENV, [task("b")], { since: epoch(), readAt: 2 });
    expect(environment().order).toEqual(["b"]);
    expect(environment().tasks.a).toBeUndefined();
  });

  it("never lets a read that started earlier undo a newer task, a creation or a removal", () => {
    store().applyList(ENV, [task("a"), task("gone")], { since: epoch(), readAt: 1 });
    const since = epoch();
    // While the read is out: a save lands, a task is created and one is removed.
    store().applyTask(ENV, task("a", { revision: 2, title: "Saved" }));
    store().applyTask(ENV, task("new"));
    store().removeTask(ENV, "gone");
    store().applyList(ENV, [task("a"), task("gone")], { since, readAt: 2 });

    expect(environment().tasks.a?.title).toBe("Saved");
    expect(environment().tasks.new).toBeDefined();
    expect(environment().tasks.gone).toBeUndefined();
    expect(environment().order).toEqual(["a", "new"]);
    // The next read is newer than all of it and wins outright.
    store().applyList(ENV, [task("a", { revision: 3 })], { since: epoch(), readAt: 3 });
    expect(environment().order).toEqual(["a"]);
    expect(environment().touchedAt).toEqual({});
  });

  it("keeps a copy read after a list started when the list has its revision", () => {
    store().applyList(ENV, [task("a", { delegations: [delegation("one", 1, "starting")] })], {
      since: epoch(),
      readAt: 1,
    });
    const since = epoch();
    // A start failing doesn't move the revision: the copy read since is the newer one.
    store().applyTask(ENV, task("a", { delegations: [delegation("one", 1, "failed")] }));
    store().applyList(ENV, [task("a", { delegations: [delegation("one", 1, "starting")] })], {
      since,
      readAt: 2,
    });
    expect(environment().tasks.a?.delegations[0]?.status).toBe("failed");
  });

  it("unites starts by command id, the node's newer copy winning, and drops confirmed optimistic starts", () => {
    store().applyTask(ENV, task("a", { delegations: [delegation("one", 1, "starting")] }));
    store().setOverlay(ENV, "a", (overlay) => ({
      ...overlay,
      optimisticStarts: [optimisticStart("two"), optimisticStart("three")],
    }));
    // A read that knows the second start but not the first.
    store().applyList(ENV, [task("a", { delegations: [delegation("two", 2, "running")] })], {
      since: epoch(),
      readAt: 1,
    });
    expect(environment().tasks.a?.delegations.map((entry) => entry.commandId)).toEqual([
      "command-one",
      "command-two",
    ]);
    expect(environment().overlays.a?.optimisticStarts).toEqual([optimisticStart("three")]);

    store().applyTask(
      ENV,
      task("a", {
        delegations: [delegation("one", 1, "review"), delegation("three", 3, "running")],
      }),
    );
    expect(
      environment().tasks.a?.delegations.map((entry) => [entry.commandId, entry.status]),
    ).toEqual([
      ["command-one", "review"],
      ["command-two", "running"],
      ["command-three", "running"],
    ]);
    // Nothing left to show: the overlay is gone.
    expect(environment().overlays.a).toBeUndefined();
  });

  it("drops overlays of tasks that are gone unless they were created here", () => {
    store().applyTask(ENV, task("a"));
    store().setOverlay(ENV, "a", (overlay) => ({ ...overlay, patch: { title: "Edit" } }));
    store().setOverlay(ENV, "draft", (overlay) => ({ ...overlay, created: task("draft") }));
    store().applyList(ENV, [], { since: epoch(), readAt: 1 });
    expect(Object.keys(environment().overlays)).toEqual(["draft"]);
  });
});

describe("applyTask", () => {
  it("accepts an equal or newer revision and only adds starts from an older one", () => {
    store().applyTask(ENV, task("a", { revision: 3, title: "Three" }));
    const three = environment().tasks.a;
    store().applyTask(ENV, task("a", { revision: 3, title: "Three" }));
    expect(environment().tasks.a).toBe(three);
    // A start never changes the revision, so an equal one may carry newer chat states.
    store().applyTask(ENV, task("a", { revision: 3, title: "Three", status: "running" }));
    expect(environment().tasks.a?.status).toBe("running");
    store().applyTask(ENV, task("a", { revision: 4, title: "Four" }));
    expect(environment().tasks.a?.title).toBe("Four");

    store().applyTask(
      ENV,
      task("a", { revision: 2, title: "Two", delegations: [delegation("one", 1)] }),
    );
    expect(environment().tasks.a).toMatchObject({ revision: 4, title: "Four" });
    expect(environment().tasks.a?.delegations).toHaveLength(1);
  });

  it("confirms a task created here", () => {
    store().setOverlay(ENV, "a", (overlay) => ({
      ...overlay,
      created: task("a", { revision: 0 }),
    }));
    expect(view("a")?.creating).toBe(true);
    store().applyTask(ENV, task("a"));
    expect(environment().overlays.a).toBeUndefined();
    expect(view("a")?.creating).toBe(false);
  });
});

describe("selectTaskView", () => {
  it("applies the overlay and stays stable while nothing changes", () => {
    store().applyTask(ENV, task("a", { delegations: [delegation("one", 1, "review")] }));
    const plain = view("a");
    expect(plain).toMatchObject({ title: "Task a", status: "review", saving: false });
    expect(view("a")).toBe(plain);

    store().setOverlay(ENV, "a", (overlay) => ({
      ...overlay,
      patch: { title: "Renamed", state: "done" },
      patchedAt: "2026-10-18T01:00:00.000Z",
    }));
    expect(view("a")).toMatchObject({
      title: "Renamed",
      state: "done",
      status: "done",
      saving: true,
      updatedAt: "2026-10-18T01:00:00.000Z",
    });

    store().setOverlay(ENV, "a", (overlay) => ({
      ...overlay,
      patch: null,
      patchedAt: null,
      optimisticStarts: [optimisticStart("two")],
    }));
    expect(view("a")).toMatchObject({ status: "starting", saving: false });
    expect(view("a")?.optimisticStarts).toHaveLength(1);

    store().setOverlay(ENV, "a", (overlay) => ({ ...overlay, hidden: true }));
    expect(view("a")).toBeUndefined();
  });

  it("lets a task leave its unavailable project", () => {
    store().applyTask(ENV, task("a", { status: "unavailable" }));
    expect(view("a")?.status).toBe("unavailable");
    store().setOverlay(ENV, "a", (overlay) => ({ ...overlay, patch: { projectId: PROJECT_B } }));
    expect(view("a")?.status).toBe("todo");
  });
});

describe("selectTaskIds", () => {
  it("lists open tasks newest first and completed ones most recently changed first", () => {
    store().applyList(
      ENV,
      [
        task("old", { createdAt: "2026-10-01T00:00:00.000Z" }),
        task("new", { createdAt: "2026-10-03T00:00:00.000Z", projectId: PROJECT_B }),
        task("done-early", { state: "done", updatedAt: "2026-10-04T00:00:00.000Z" }),
        task("done-late", { state: "done", updatedAt: "2026-10-05T00:00:00.000Z" }),
      ],
      { since: epoch(), readAt: 1 },
    );
    store().setOverlay(ENV, "draft", (overlay) => ({
      ...overlay,
      created: task("draft", { createdAt: "2026-10-06T00:00:00.000Z" }),
    }));

    expect(selectTaskIds(store(), ENV, { done: false, projectId: null })).toEqual([
      "draft",
      "new",
      "old",
    ]);
    expect(selectTaskIds(store(), ENV, { done: false, projectId: PROJECT_B })).toEqual(["new"]);
    expect(selectTaskIds(store(), ENV, { done: true, projectId: null })).toEqual([
      "done-late",
      "done-early",
    ]);

    // Checking a task off moves it to the top of the completed ones at once.
    store().setOverlay(ENV, "old", (overlay) => ({
      ...overlay,
      patch: { state: "done" },
      patchedAt: "2026-10-18T00:00:00.000Z",
    }));
    expect(selectTaskIds(store(), ENV, { done: true, projectId: null })).toEqual([
      "old",
      "done-late",
      "done-early",
    ]);
    expect(selectOpenTaskViews(store(), ENV).map((entry) => entry.taskId)).toEqual([
      "draft",
      "new",
    ]);
  });

  it("returns the same array while the list it describes is unchanged", () => {
    store().applyList(ENV, [task("a"), task("b")], { since: epoch(), readAt: 1 });
    const ids = selectTaskIds(store(), ENV, { done: false, projectId: null });
    const views = selectOpenTaskViews(store(), ENV);
    store().applyTask(ENV, task("a", { revision: 2, title: "Renamed" }));
    expect(selectTaskIds(store(), ENV, { done: false, projectId: null })).toBe(ids);
    expect(selectOpenTaskViews(store(), ENV)).not.toBe(views);
    store().setLoading(ENV);
    expect(selectTaskIds(store(), ENV, { done: false, projectId: null })).toBe(ids);
  });
});

describe("clear", () => {
  it("forgets the environment", () => {
    store().applyTask(ENV, task("a"));
    store().setError(ENV, { kind: "read", message: "offline" });
    expect(environment()).toMatchObject({ status: "error", error: { kind: "read" } });
    store().clear(ENV);
    expect(environment()).toBe(EMPTY_LOCAL_TASKS_STATE);
  });
});
