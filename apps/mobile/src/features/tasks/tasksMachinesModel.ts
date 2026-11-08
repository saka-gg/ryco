import type { EnvironmentId, ProjectId } from "@ryco/contracts";

// Tasks belong to one machine (each node keeps its own list), so the Tasks tab
// shows one machine's at a time and offers the others in its picker. Pure, so
// which machines qualify and which one shows are testable.

export interface TaskMachineEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connected" | "reconnecting" | "offline" | "read-only";
  readonly role?: "viewer" | "operator" | "owner" | "client";
}

export interface TaskMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
}

/**
 * The machines whose tasks this phone may show: tasks are the node owner's,
 * so a session known to have another role is left out, as is a node known not
 * to have tasks (`capabilities.localTasks`) or one that refused this session
 * its tasks. A machine whose config has not arrived yet stays listed.
 */
export function deriveTaskMachines(input: {
  readonly environments: ReadonlyArray<TaskMachineEnvironment>;
  /** `capabilities.localTasks` by machine; absent while its config is unknown. */
  readonly supported: ReadonlyMap<EnvironmentId, boolean>;
  readonly forbidden: Readonly<Record<string, true>>;
}): ReadonlyArray<TaskMachine> {
  const machines: TaskMachine[] = [];
  for (const environment of input.environments) {
    if (environment.role !== undefined && environment.role !== "owner") continue;
    if (input.supported.get(environment.environmentId) === false) continue;
    if (environment.environmentId in input.forbidden) continue;
    machines.push({
      environmentId: environment.environmentId,
      label: environment.label,
      connected:
        environment.connectionState === "connected" || environment.connectionState === "read-only",
    });
  }
  return machines;
}

/** The machine the tab shows: the one picked last while it qualifies, else the first connected. */
export function resolveTaskMachine(
  machines: ReadonlyArray<TaskMachine>,
  savedEnvironmentId: string | null,
): TaskMachine | null {
  return (
    machines.find((machine) => machine.environmentId === savedEnvironmentId) ??
    machines.find((machine) => machine.connected) ??
    machines[0] ??
    null
  );
}

/** What the tab remembers on the device: ids only, never task content. */
export interface TasksTabState {
  readonly environmentId: string | null;
  /** The project filter; null for every project. */
  readonly projectId: string | null;
  /** Completed tasks are listed in full rather than the latest few. */
  readonly showAllDone: boolean;
}

export const DEFAULT_TASKS_TAB_STATE: TasksTabState = {
  environmentId: null,
  projectId: null,
  showAllDone: false,
};

export const TASKS_TAB_STATE_KEY = "ryco.tasks.tab.v1";

const MAX_ID_LENGTH = 256;

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

export function sanitizeTasksTabState(raw: unknown): TasksTabState {
  if (raw === null || typeof raw !== "object") return DEFAULT_TASKS_TAB_STATE;
  const value = raw as Record<string, unknown>;
  return {
    environmentId: id(value.environmentId),
    projectId: id(value.projectId),
    showAllDone: value.showAllDone === true,
  };
}

/** Picking another machine drops the project filter, which named one of the old machine's. */
export function selectTaskMachine(state: TasksTabState, environmentId: string): TasksTabState {
  if (state.environmentId === environmentId) return state;
  return { ...state, environmentId, projectId: null };
}

/** The project filter, kept only while the machine still has the project. */
export function resolveTaskProjectFilter(
  state: TasksTabState,
  projects: ReadonlyArray<{ readonly id: ProjectId }>,
): ProjectId | null {
  if (state.projectId === null) return null;
  return projects.find((project) => project.id === state.projectId)?.id ?? null;
}
