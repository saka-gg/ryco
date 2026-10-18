import type { TaskView } from "./tasksViewModel";

/**
 * How long a checked (or unchecked) row keeps its place, showing its new
 * state, before it moves to the other list. A behaviour constant, not
 * motion: reduced motion keeps it, so the check still reads before the row
 * goes.
 */
export const TASK_COMPLETE_SETTLE_MS = 420;

export type TaskListName = "open" | "done";

/** A row held where it was toggled until it settles. */
export interface SettlingTask {
  readonly list: TaskListName;
  /** Its index in that list when it was toggled. */
  readonly index: number;
  /** What its checkbox shows meanwhile. */
  readonly checked: boolean;
  /** The row as it was when toggled: its details and meta don't change until it moves. */
  readonly snapshot: TaskView;
}

export interface TaskListEntry {
  readonly task: TaskView;
  readonly checked: boolean;
}

export interface SettledTaskLists {
  readonly open: ReadonlyArray<TaskListEntry>;
  readonly done: ReadonlyArray<TaskListEntry>;
}

function entriesOf(tasks: ReadonlyArray<TaskView>): TaskListEntry[] {
  return tasks.map((task) => ({ task, checked: task.done }));
}

/**
 * The lists as shown: the model's, except that each settling task stays in
 * the list it was toggled in, at its old index, as it was, with its new
 * checkbox state. A settling task the model no longer has at all (deleted,
 * or outside a new filter) is not held.
 */
export function settleTaskLists(
  openTasks: ReadonlyArray<TaskView>,
  doneTasks: ReadonlyArray<TaskView>,
  settling: ReadonlyMap<string, SettlingTask>,
): SettledTaskLists {
  if (settling.size === 0) return { open: entriesOf(openTasks), done: entriesOf(doneTasks) };
  const present = new Set<string>();
  for (const task of openTasks) present.add(task.id);
  for (const task of doneTasks) present.add(task.id);

  const build = (name: TaskListName, tasks: ReadonlyArray<TaskView>): TaskListEntry[] => {
    const entries: TaskListEntry[] = [];
    for (const task of tasks) {
      const held = settling.get(task.id);
      if (held === undefined) entries.push({ task, checked: task.done });
    }
    const holds = [...settling.entries()]
      .filter(([id, held]) => held.list === name && present.has(id))
      .toSorted((a, b) => a[1].index - b[1].index);
    for (const [, held] of holds) {
      entries.splice(Math.min(held.index, entries.length), 0, {
        task: held.snapshot,
        checked: held.checked,
      });
    }
    return entries;
  };

  return { open: build("open", openTasks), done: build("done", doneTasks) };
}
