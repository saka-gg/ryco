import { describe, expect, it } from "vite-plus/test";

import { type SettlingTask, settleTaskLists } from "./taskListSettle.logic";
import type { TaskView } from "./tasksViewModel";

const task = (id: string, done = false): TaskView => ({
  id,
  title: id,
  notes: "",
  done,
  projectId: null,
  dueAt: null,
  links: [],
  files: [],
  chats: [],
  status: null,
  whereOptions: [],
  starting: false,
  projectLocked: false,
});

const ids = (entries: ReadonlyArray<{ readonly task: TaskView; readonly checked: boolean }>) =>
  entries.map((entry) => `${entry.task.id}${entry.checked ? "✓" : ""}`);

describe("settleTaskLists", () => {
  it("passes the model's lists through when nothing settles", () => {
    const lists = settleTaskLists([task("a"), task("b")], [task("c", true)], new Map());
    expect(ids(lists.open)).toEqual(["a", "b"]);
    expect(ids(lists.done)).toEqual(["c✓"]);
  });

  it("holds a checked task at its old index in the open list, as it was", () => {
    const before = task("b");
    const settling = new Map<string, SettlingTask>([
      ["b", { list: "open", index: 1, checked: true, snapshot: before }],
    ]);
    const lists = settleTaskLists([task("a"), task("c")], [task("b", true)], settling);
    expect(ids(lists.open)).toEqual(["a", "b✓", "c"]);
    expect(lists.open[1]?.task).toBe(before);
    expect(ids(lists.done)).toEqual([]);
  });

  it("holds several tasks at their own indexes", () => {
    const settling = new Map<string, SettlingTask>([
      ["d", { list: "open", index: 3, checked: true, snapshot: task("d") }],
      ["b", { list: "open", index: 1, checked: true, snapshot: task("b") }],
    ]);
    const lists = settleTaskLists(
      [task("a"), task("c")],
      [task("b", true), task("d", true)],
      settling,
    );
    expect(ids(lists.open)).toEqual(["a", "b✓", "c", "d✓"]);
  });

  it("holds an unchecked task in the Completed list", () => {
    const settling = new Map<string, SettlingTask>([
      ["x", { list: "done", index: 0, checked: false, snapshot: task("x", true) }],
    ]);
    const lists = settleTaskLists([task("x"), task("a")], [task("y", true)], settling);
    expect(ids(lists.open)).toEqual(["a"]);
    expect(ids(lists.done)).toEqual(["x", "y✓"]);
  });

  it("drops a hold the model no longer has at all", () => {
    const settling = new Map<string, SettlingTask>([
      ["gone", { list: "open", index: 0, checked: true, snapshot: task("gone") }],
    ]);
    const lists = settleTaskLists([task("a")], [], settling);
    expect(ids(lists.open)).toEqual(["a"]);
  });
});
