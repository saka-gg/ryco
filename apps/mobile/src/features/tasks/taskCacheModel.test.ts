import type { LocalTask } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decodeTaskCache, encodeTaskCache, TASK_CACHE_MAX_TASKS } from "./taskCacheModel";

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

describe("task cache format", () => {
  it("reads back what it wrote", () => {
    const encoded = encodeTaskCache([task("a"), task("b", { state: "done", status: "done" })], 42);
    expect(decodeTaskCache(encoded)).toEqual({
      version: 1,
      readAt: 42,
      tasks: [task("a"), task("b", { state: "done", status: "done" })],
    });
  });

  it("keeps open tasks first and the latest done ones within the bound", () => {
    const open = Array.from({ length: TASK_CACHE_MAX_TASKS - 1 }, (_, index) => task(`o${index}`));
    const done = [
      task("old", { state: "done", status: "done", updatedAt: "2026-10-01T00:00:00.000Z" }),
      task("new", { state: "done", status: "done", updatedAt: "2026-10-20T00:00:00.000Z" }),
    ];
    const kept = decodeTaskCache(encodeTaskCache([...done, ...open], 1))!.tasks;
    expect(kept).toHaveLength(TASK_CACHE_MAX_TASKS);
    expect(kept.at(-1)?.taskId).toBe("new");
  });

  it("drops what it cannot read", () => {
    expect(decodeTaskCache(null)).toBeNull();
    expect(decodeTaskCache("not json")).toBeNull();
    expect(decodeTaskCache(JSON.stringify({ version: 2, readAt: 1, tasks: [] }))).toBeNull();
    const mixed = JSON.stringify({ version: 1, readAt: 1, tasks: [task("ok"), { taskId: 5 }] });
    expect(decodeTaskCache(mixed)!.tasks.map((entry) => entry.taskId)).toEqual(["ok"]);
  });
});
