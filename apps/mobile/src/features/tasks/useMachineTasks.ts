import {
  selectLocalTasksEnvironment,
  selectTaskIds,
  selectTaskView,
  useLocalTasksStore,
  type LocalTaskThreadSummaryReader,
  type LocalTaskView,
  type LocalTasksEnvironmentState,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import {
  fullThreadEntry,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  useStore,
  type Project,
} from "../../state/threadsRuntime";
import { machinePickerEnvironmentsAmong } from "../home/machinePickerModel";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { useHostedDemandCandidates } from "../home/useHostedDemandCandidates";
import {
  registerTaskConnectionDemand,
  setTaskDemandHub,
  useReachableTaskMachines,
} from "./taskConnectionDemand";
import { deriveTaskMachines, type TaskMachine } from "./tasksMachinesModel";
import { retainMobileLocalTasks } from "./tasksRuntime";

/** The machines whose tasks this phone may show (`deriveTaskMachines`). */
export function useTaskMachines(): ReadonlyArray<TaskMachine> {
  const environments = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  const forbidden = useLocalTasksStore((state) => state.forbidden);
  const reachable = useReachableTaskMachines();
  return useMemo(() => {
    const supported = new Map<EnvironmentId, boolean>();
    for (const [environmentId, config] of configs)
      supported.set(environmentId, config.environment.capabilities.localTasks === true);
    return deriveTaskMachines({ environments, supported, forbidden, reachable });
  }, [configs, environments, forbidden, reachable]);
}

/** The task machines as the shared machine picker lists them, with their connection. */
export function useTaskPickerEnvironments(machines: ReadonlyArray<TaskMachine>) {
  const environments = useHomeEnvironments();
  const key = machines.map((machine) => machine.environmentId).join("\u0000");
  return useMemo(
    () =>
      machinePickerEnvironmentsAmong(
        environments,
        key.length === 0 ? [] : (key.split("\u0000") as EnvironmentId[]),
      ),
    [environments, key],
  );
}

/**
 * Keeps each machine's tasks live while mounted. With `demand`, the machines
 * reached through the Hub are asked for too (`taskConnectionDemand.ts`): within
 * the bounded warm set the first few stay connected and follow the change
 * feed, the rest are read one at a time, and an offline one is never asked
 * for. `priority` machines (the one picked, a capture's, the one a sheet
 * edits) come first.
 */
export function useRetainLocalTasks(
  environmentIds: ReadonlyArray<EnvironmentId>,
  options?: { readonly demand?: boolean; readonly priority?: ReadonlyArray<EnvironmentId> },
): void {
  const key = environmentIds.join("\u0000");
  const priorityKey = (options?.priority ?? []).join("\u0000");
  const demand = options?.demand === true;
  useEffect(() => {
    if (key.length === 0) return undefined;
    const releases = key.split("\u0000").map((id) => retainMobileLocalTasks(id as EnvironmentId));
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
  const hub = useHostedDemandCandidates();
  useEffect(() => {
    if (demand) setTaskDemandHub(hub);
  }, [demand, hub]);
  useEffect(() => {
    if (!demand || key.length === 0) return undefined;
    const ids = (joined: string) =>
      joined.length === 0 ? [] : (joined.split("\u0000") as EnvironmentId[]);
    return registerTaskConnectionDemand(ids(key), ids(priorityKey));
  }, [demand, key, priorityKey]);
}

/** Every task of one machine's list as shown (open first, then done), from its store slice. */
export function taskViewsOf(
  environmentId: EnvironmentId,
  environment: LocalTasksEnvironmentState,
): ReadonlyArray<LocalTaskView> {
  const slice = { byEnvironment: { [environmentId]: environment } };
  const views: LocalTaskView[] = [];
  for (const done of [false, true]) {
    for (const taskId of selectTaskIds(slice, environmentId, { done, projectId: null })) {
      const view = selectTaskView(slice, environmentId, taskId);
      if (view) views.push(view);
    }
  }
  return views;
}

type ThreadSummaries = ReturnType<typeof selectEnvironmentState>["sidebarThreadSummaryById"];

export interface MachineTasks {
  readonly environment: LocalTasksEnvironmentState;
  readonly tasks: ReadonlyArray<LocalTaskView>;
  /** The machine's projects a task can belong to, in the order the node lists them. */
  readonly projects: ReadonlyArray<Project>;
  /** The machine's chats as the task rules read them. */
  readonly getSummary: LocalTaskThreadSummaryReader;
  /** The machine's chats by id, for their titles and projects. */
  readonly summaries: ThreadSummaries;
}

const NO_SUMMARIES: ThreadSummaries = {};

/** One machine's tasks, kept live while mounted, with what their rows need. */
export function useMachineTasks(environmentId: EnvironmentId | null): MachineTasks {
  const ids = environmentId === null ? [] : [environmentId];
  useRetainLocalTasks(ids, { demand: true, priority: ids });
  const environment = useLocalTasksStore((state) =>
    environmentId === null
      ? selectLocalTasksEnvironment(state, "" as EnvironmentId)
      : selectLocalTasksEnvironment(state, environmentId),
  );
  const tasks = useMemo(
    () => (environmentId === null ? [] : taskViewsOf(environmentId, environment)),
    [environment, environmentId],
  );
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projects = useMemo(
    () =>
      excludeChatProjects(allProjects.filter((project) => project.environmentId === environmentId)),
    [allProjects, environmentId],
  );
  const summaries = useStore((state) =>
    environmentId === null
      ? NO_SUMMARIES
      : selectEnvironmentState(state, environmentId).sidebarThreadSummaryById,
  );
  const getSummary = useMemo<LocalTaskThreadSummaryReader>(
    () => (threadId) => fullThreadEntry(summaries[threadId]),
    [summaries],
  );
  return { environment, tasks, projects, getSummary, summaries };
}

/** One machine's part of the merged list. */
export interface MachineTaskSlice {
  readonly machine: TaskMachine;
  readonly environment: LocalTasksEnvironmentState;
  readonly tasks: ReadonlyArray<LocalTaskView>;
  readonly projects: ReadonlyArray<Project>;
  readonly getSummary: LocalTaskThreadSummaryReader;
}

/**
 * Every machine's tasks, kept live while mounted: directly paired machines and
 * the ones reached through the Hub alike (each through its own connection).
 */
export function useTasksAcrossMachines(
  machines: ReadonlyArray<TaskMachine>,
  options?: { readonly demand?: boolean; readonly priority?: ReadonlyArray<EnvironmentId> },
): ReadonlyArray<MachineTaskSlice> {
  useRetainLocalTasks(
    machines.map((machine) => machine.environmentId),
    options,
  );
  const environments = useLocalTasksStore(
    useShallow((state) =>
      machines.map((machine) => selectLocalTasksEnvironment(state, machine.environmentId)),
    ),
  );
  const summaries = useStore(
    useShallow((state) =>
      machines.map(
        (machine) => selectEnvironmentState(state, machine.environmentId).sidebarThreadSummaryById,
      ),
    ),
  );
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useMemo(
    () =>
      machines.map((machine, index) => {
        const environment = environments[index]!;
        const machineSummaries = summaries[index] ?? NO_SUMMARIES;
        return {
          machine,
          environment,
          tasks: taskViewsOf(machine.environmentId, environment),
          projects: excludeChatProjects(
            allProjects.filter((project) => project.environmentId === machine.environmentId),
          ),
          getSummary: (threadId) => fullThreadEntry(machineSummaries[threadId]),
        };
      }),
    [allProjects, environments, machines, summaries],
  );
}
