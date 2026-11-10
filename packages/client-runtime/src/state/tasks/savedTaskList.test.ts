import type { EnvironmentId, LocalTask } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  applySavedTaskList,
  boundSavedTaskList,
  decodeSavedTaskList,
  encodeSavedTaskList,
  parseSavedTaskList,
  SAVED_TASK_LIST_MAX_BYTES,
  SAVED_TASK_LIST_MAX_TASKS,
} from "./savedTaskList.ts";
import { selectLocalTasksEnvironment, useLocalTasksStore } from "./store.ts";

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
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    status: "todo",
    delegations: [],
    ...overrides,
  };
}

describe("saved task list format", () => {
  it("reads back what it wrote", () => {
    const encoded = encodeSavedTaskList(
      [task("a"), task("b", { state: "done", status: "done" })],
      42,
    );
    expect(parseSavedTaskList(encoded)).toEqual({
      version: 1,
      readAt: 42,
      tasks: [task("a"), task("b", { state: "done", status: "done" })],
    });
  });

  it("keeps open tasks first and the latest done ones within the bound", () => {
    const open = Array.from({ length: SAVED_TASK_LIST_MAX_TASKS - 1 }, (_, index) =>
      task(`o${index}`),
    );
    const done = [
      task("old", { state: "done", status: "done", updatedAt: "2026-10-01T00:00:00.000Z" }),
      task("new", { state: "done", status: "done", updatedAt: "2026-10-20T00:00:00.000Z" }),
    ];
    const kept = parseSavedTaskList(encodeSavedTaskList([...done, ...open], 1))!.tasks;
    expect(kept).toHaveLength(SAVED_TASK_LIST_MAX_TASKS);
    expect(kept.at(-1)?.taskId).toBe("new");
  });

  it("drops what it cannot read", () => {
    expect(parseSavedTaskList(null)).toBeNull();
    expect(parseSavedTaskList("not json")).toBeNull();
    expect(parseSavedTaskList(JSON.stringify({ version: 2, readAt: 1, tasks: [] }))).toBeNull();
    const mixed = JSON.stringify({ version: 1, readAt: 1, tasks: [task("ok"), { taskId: 5 }] });
    expect(parseSavedTaskList(mixed)!.tasks.map((entry) => entry.taskId)).toEqual(["ok"]);
  });
});

describe("saved task list bounds and decoding", () => {
  it("keeps no copy of a list larger than the byte bound", () => {
    const huge = [task("big", { notes: "x".repeat(SAVED_TASK_LIST_MAX_BYTES) })];
    expect(boundSavedTaskList(huge, 1)).toBeNull();
    expect(encodeSavedTaskList(huge, 1)).toBeNull();
  });

  it("reads an untrusted object copy (structured stores)", () => {
    expect(decodeSavedTaskList(null)).toBeNull();
    expect(decodeSavedTaskList([])).toBeNull();
    expect(decodeSavedTaskList({ version: 1, readAt: Number.NaN, tasks: [] })).toBeNull();
    expect(decodeSavedTaskList({ version: 1, readAt: 3, tasks: "no" })).toBeNull();
    expect(
      decodeSavedTaskList({ version: 1, readAt: 3, tasks: [task("ok"), null] })?.tasks.map(
        (entry) => entry.taskId,
      ),
    ).toEqual(["ok"]);
  });
});

describe("applying a saved task list", () => {
  const environmentId = "environment-saved-tasks" as EnvironmentId;
  afterEach(() => useLocalTasksStore.getState().clear(environmentId));

  it("fills a machine nothing was read from, and never replaces a live read", () => {
    const saved = boundSavedTaskList([task("a")], 10)!;
    expect(applySavedTaskList(useLocalTasksStore, environmentId, saved)).toBe(true);
    const shown = selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId);
    expect(Object.keys(shown.tasks)).toEqual(["a"]);
    expect(shown.readAt).toBe(10);
    // Something is shown now (a copy or a read): another copy does not replace it.
    expect(
      applySavedTaskList(useLocalTasksStore, environmentId, boundSavedTaskList([task("b")], 20)!),
    ).toBe(false);
  });

  it("applies nothing for an empty copy", () => {
    expect(applySavedTaskList(useLocalTasksStore, environmentId, boundSavedTaskList([], 10)!)).toBe(
      false,
    );
  });
});
