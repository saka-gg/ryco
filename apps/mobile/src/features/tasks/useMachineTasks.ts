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

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { useHostedHubStore } from "../../hostedHub/state";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import {
  fullThreadEntry,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  useStore,
  type Project,
} from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { deriveTaskMachines, type TaskMachine } from "./tasksMachinesModel";
import { retainMobileLocalTasks } from "./tasksRuntime";

/** The machines whose tasks this phone may show (`deriveTaskMachines`). */
export function useTaskMachines(): ReadonlyArray<TaskMachine> {
  const environments = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  const forbidden = useLocalTasksStore((state) => state.forbidden);
  return useMemo(() => {
    const supported = new Map<EnvironmentId, boolean>();
    for (const [environmentId, config] of configs)
      supported.set(environmentId, config.environment.capabilities.localTasks === true);
    return deriveTaskMachines({ environments, supported, forbidden });
  }, [configs, environments, forbidden]);
}

/**
 * Keeps each machine's tasks live while mounted. With `demand`, a machine
 * reached through the Hub is also asked for: its relay connection opens on
 * demand within the bounded warm set (pre-emptible, below thread work), so a
 * visible Tasks surface reads every machine's list and follows its changes.
 */
export function useRetainLocalTasks(
  environmentIds: ReadonlyArray<EnvironmentId>,
  options?: { readonly demand?: boolean },
): void {
  const key = environmentIds.join("\u0000");
  const demand = options?.demand === true;
  const hostedKey = useHostedHubStore(
    useShallow((state) => state.nodes.map((node) => node.environmentId as string)),
  ).join("\u0000");
  useEffect(() => {
    if (key.length === 0) return undefined;
    const releases = key.split("\u0000").map((id) => retainMobileLocalTasks(id as EnvironmentId));
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
  useEffect(() => {
    if (!demand || key.length === 0 || hostedKey.length === 0) return undefined;
    const hosted = new Set(hostedKey.split("\u0000"));
    const releases = key
      .split("\u0000")
      .filter((id) => hosted.has(id))
      .map((id) =>
        mobileHostedConnectionScopes.retain(id as EnvironmentId, { type: "local-tasks" }),
      );
    return () => {
      for (const release of releases) release();
    };
  }, [demand, hostedKey, key]);
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
  useRetainLocalTasks(environmentId === null ? [] : [environmentId], { demand: true });
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
  options?: { readonly demand?: boolean },
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
