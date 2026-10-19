import { getRouteApi } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { TasksPage } from "../tasks/TasksPage";
import type { TasksSearch } from "../tasks/tasksSearch";

const tasksRouteApi = getRouteApi("/tasks");

/** The `/tasks` route body, loaded by the route file through `lazyRouteComponent`. */
export function TasksRoute(): ReactElement {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the lazy component/Route declaration inference cycle.
  const search = tasksRouteApi.useSearch() as TasksSearch;
  const navigate = tasksRouteApi.useNavigate();
  return (
    <TasksPage
      search={search}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
