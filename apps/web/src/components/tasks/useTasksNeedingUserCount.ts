import {
  countTasksNeedingUser,
  selectOpenTaskViews,
  useLocalTasksStore,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import { fullThreadEntry, type AppState } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";

import { selectEnvironmentState, useStore } from "~/store";

import { useLocalTasksSync } from "./useLocalTasks";
import { tasksAvailable, useTasksEnvironment } from "./useTasksEnvironment";

const NO_TASKS: ReadonlyArray<LocalTaskView> = [];

function hasChats(task: LocalTaskView): boolean {
  return (
    task.delegations.length > 0 ||
    task.optimisticStarts.length > 0 ||
    task.links.some((link) => link.kind === "thread")
  );
}

/**
 * Counts against the environment's thread summaries, recounting only when
 * that record changes: the thread store commits on every streaming delta,
 * and those must cost the sidebar nothing.
 */
function createNeedingUserCounter(
  tasks: ReadonlyArray<LocalTaskView>,
  environmentId: EnvironmentId | null,
): (state: AppState) => number {
  let summaries: unknown = null;
  let count = 0;
  return (state) => {
    if (!environmentId || tasks.length === 0) return 0;
    const current = selectEnvironmentState(state, environmentId).sidebarThreadSummaryById;
    if (current !== summaries) {
      summaries = current;
      count = countTasksNeedingUser(tasks, (threadId) => fullThreadEntry(current[threadId]));
    }
    return count;
  };
}

/**
 * Open tasks with a chat waiting on the user: the sidebar entry's badge. It
 * keeps the tasks retained itself, so the badge is live on every route, and
 * re-renders its caller only when the number changes.
 */
export function useTasksNeedingUserCount(): number {
  const tasks = useTasksEnvironment();
  const environmentId = tasksAvailable(tasks) ? tasks.environmentId : null;
  useLocalTasksSync(environmentId, environmentId !== null);
  const openTasks = useLocalTasksStore((state) =>
    environmentId ? selectOpenTaskViews(state, environmentId) : NO_TASKS,
  );
  // Only tasks with a chat can need the user.
  const withChats = useMemo(() => openTasks.filter(hasChats), [openTasks]);
  const counter = useMemo(
    () => createNeedingUserCounter(withChats, environmentId),
    [environmentId, withChats],
  );
  return useStore(counter);
}
