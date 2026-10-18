/**
 * URL state for `/tasks`: `project` keeps the page filtered to one project's
 * tasks across reloads and back/forward. Without it the page shows every task.
 */
export interface TasksSearch {
  readonly project?: string | undefined;
}

const MAX_ID_LENGTH = 256;

export function parseTasksSearch(raw: Record<string, unknown>): TasksSearch {
  const project = typeof raw.project === "string" ? raw.project.trim() : "";
  return project.length > 0 && project.length <= MAX_ID_LENGTH ? { project } : {};
}
