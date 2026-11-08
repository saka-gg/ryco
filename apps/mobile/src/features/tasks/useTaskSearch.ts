import { useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { taskSearchResults, type TaskSearchResult } from "./taskSearchModel";
import { taskViewsOf, useRetainLocalTasks, useTaskMachines } from "./useMachineTasks";

export type { TaskSearchResult } from "./taskSearchModel";

export interface TaskSearch {
  readonly results: ReadonlyArray<TaskSearchResult>;
  /** A machine's first read of its tasks is still on its way. */
  readonly loading: boolean;
  /** Why nothing can be searched (no machine with tasks); null when it can. */
  readonly unavailable: string | null;
}

/**
 * The Tasks scope of the app's global search: the tasks of every machine the
 * phone may show tasks of, kept live while the search is mounted. Each result
 * names the route that opens it (`TaskDetail`). Searching is local: the tasks
 * are already on the phone, so there is nothing to debounce.
 */
export function useTaskSearch(query: string): TaskSearch {
  const machines = useTaskMachines();
  const active = query.trim().length > 0;
  useRetainLocalTasks(active ? machines.map((machine) => machine.environmentId) : [], {
    demand: active,
  });
  const byEnvironment = useLocalTasksStore((state) => state.byEnvironment);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useMemo(() => {
    if (machines.length === 0)
      return { results: [], loading: false, unavailable: "No machine with tasks." };
    if (!active) return { results: [], loading: false, unavailable: null };
    let loading = false;
    const searched = machines.map((machine) => {
      const environment = byEnvironment[machine.environmentId];
      if (!environment || environment.readAt === null) loading = machine.connected || loading;
      return {
        environmentId: machine.environmentId,
        label: machine.label,
        tasks: environment ? taskViewsOf(machine.environmentId, environment) : [],
        projectNames: new Map(
          excludeChatProjects(
            projects.filter((project) => project.environmentId === machine.environmentId),
          ).map((project) => [project.id as string, project.name]),
        ),
      };
    });
    return { results: taskSearchResults(searched, query, Date.now()), loading, unavailable: null };
  }, [active, byEnvironment, machines, projects, query]);
}
