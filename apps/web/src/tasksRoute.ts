import type { ProjectId } from "@ryco/contracts";

import type { TasksSearch } from "./components/tasks/tasksSearch";

export const TASKS_ROUTE_PATH = "/tasks" as const;

/**
 * Router location for the Tasks page: every task, or one project's. The
 * sidebar entry and anything else that opens the page go through this.
 */
export function buildTasksPageLocation(input?: {
  readonly projectId?: ProjectId | null | undefined;
}): { readonly to: typeof TASKS_ROUTE_PATH; readonly search: TasksSearch } {
  return {
    to: TASKS_ROUTE_PATH,
    search: input?.projectId ? { project: input.projectId } : {},
  };
}
