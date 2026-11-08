import { dueLabel, type LocalTaskView } from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId } from "@ryco/contracts";

import { taskMatchesQuery } from "./tasksListModel";

// The Tasks scope of the app's global search, pure so ranking is testable:
// every task of the user's machines that matches the query, open ones first
// and title matches before matches in notes or links.

/** At most this many results, like the other scopes of the global search. */
export const TASK_SEARCH_LIMIT = 20;

export interface TaskSearchResult {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly title: string;
  /** "ryco · due Tue", "MacBook · done": where it lives and when it is due. */
  readonly subtitle: string;
  readonly done: boolean;
  /** A short trailing note: the due day. */
  readonly trailing: string | null;
  readonly route: {
    readonly name: "TaskDetail";
    readonly params: { readonly environmentId: EnvironmentId; readonly taskId: string };
  };
}

export interface TaskSearchMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly tasks: ReadonlyArray<LocalTaskView>;
  readonly projectNames: ReadonlyMap<string, string>;
}

function titleMatches(task: LocalTaskView, query: string): boolean {
  const title = task.title.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => title.includes(word));
}

export function taskSearchResults(
  machines: ReadonlyArray<TaskSearchMachine>,
  query: string,
  nowMs: number,
): ReadonlyArray<TaskSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const showMachine = machines.length > 1;
  const ranked: Array<{ readonly rank: number; readonly result: TaskSearchResult }> = [];
  for (const machine of machines) {
    for (const task of machine.tasks) {
      if (!taskMatchesQuery(task, trimmed)) continue;
      const done = task.state === "done";
      const due = task.dueAt === null || done ? null : dueLabel(task.dueAt, nowMs);
      const project =
        task.projectId === null ? null : (machine.projectNames.get(task.projectId) ?? null);
      const place = [showMachine ? machine.label : null, project].filter(
        (part): part is string => part !== null,
      );
      const state = done ? "done" : due === null ? null : `due ${due}`;
      ranked.push({
        rank: (done ? 2 : 0) + (titleMatches(task, trimmed) ? 0 : 1),
        result: {
          key: `task:${machine.environmentId}:${task.taskId}`,
          environmentId: machine.environmentId,
          taskId: task.taskId,
          title: task.title,
          subtitle: [...place, ...(state === null ? [] : [state])].join(" · "),
          done,
          trailing: due,
          route: {
            name: "TaskDetail",
            params: { environmentId: machine.environmentId, taskId: task.taskId },
          },
        },
      });
    }
  }
  return ranked
    .toSorted((left, right) => left.rank - right.rank)
    .slice(0, TASK_SEARCH_LIMIT)
    .map(({ result }) => result);
}
