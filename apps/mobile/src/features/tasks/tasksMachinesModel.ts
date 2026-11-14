import type { EnvironmentId, NodeSessionRole, ProjectId } from "@ryco/contracts";

// Tasks belong to one machine (each node keeps its own list), so the Tasks tab
// shows one machine's at a time and offers the others in its picker. Pure, so
// which machines qualify and which one shows are testable.

export interface TaskMachineEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connected" | "reconnecting" | "offline" | "read-only";
  readonly role?: NodeSessionRole;
}

export interface TaskMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Connected now: its list follows the change feed. */
  readonly connected: boolean;
  /**
   * Its tasks can change: connected, or a Hub machine the Hub lists online
   * whose connection slot went to another machine (a write to it waits for
   * its connection). Not reachable means offline: shown as last read, read-only.
   */
  readonly reachable: boolean;
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
  /** Hub machines online and connectable, connected or not (`taskConnectionDemand.ts`). */
  readonly reachable?: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<TaskMachine> {
  const machines: TaskMachine[] = [];
  for (const environment of input.environments) {
    if (environment.role !== undefined && environment.role !== "owner") continue;
    if (input.supported.get(environment.environmentId) === false) continue;
    if (environment.environmentId in input.forbidden) continue;
    const connected =
      environment.connectionState === "connected" || environment.connectionState === "read-only";
    machines.push({
      environmentId: environment.environmentId,
      label: environment.label,
      connected,
      reachable: connected || (input.reachable?.has(environment.environmentId) ?? false),
    });
  }
  return machines;
}

/**
 * The machine the list is filtered to: the one picked last while it is still
 * listed; null shows every machine's tasks merged.
 */
export function resolveTaskMachineFilter(
  machines: ReadonlyArray<TaskMachine>,
  savedEnvironmentId: string | null,
): TaskMachine | null {
  return machines.find((machine) => machine.environmentId === savedEnvironmentId) ?? null;
}

/**
 * The machine a new task goes to: the one asked for (a chat's, a pull
 * request's), else the one the list is filtered to, else the one used last,
 * else the first reachable one. Only a reachable machine takes a new task.
 * A machine asked for that is not reachable gives `unavailable` instead of
 * another machine: a task made from a chat or pull request belongs with it.
 */
export function resolveCaptureMachine(
  machines: ReadonlyArray<TaskMachine>,
  preferred: ReadonlyArray<string | null | undefined>,
  required?: string | null,
): TaskMachine | "unavailable" | null {
  const reachable = machines.filter((machine) => machine.reachable);
  if (required) {
    return reachable.find((machine) => machine.environmentId === required) ?? "unavailable";
  }
  for (const environmentId of preferred) {
    const match = reachable.find((machine) => machine.environmentId === environmentId);
    if (match) return match;
  }
  return reachable[0] ?? null;
}

/**
 * The project a new task on `environmentId` starts in: the one asked for, else
 * the list's project filter on that machine, else the last one used there
 * while the machine still has it; null for none.
 */
export function resolveCaptureProject(
  state: TasksTabState,
  environmentId: string,
  projects: ReadonlyArray<{ readonly id: ProjectId }>,
  requested?: string | null,
): ProjectId | null {
  const has = (projectId: string | null | undefined) =>
    projectId ? (projects.find((project) => project.id === projectId)?.id ?? null) : null;
  if (requested !== undefined) return has(requested);
  if (state.environmentId === environmentId && state.projectId !== null)
    return has(state.projectId);
  return has(state.captureProjectIds[environmentId]);
}

/** Remembers where a task was just added, so the next one starts there. */
export function rememberCapture(
  state: TasksTabState,
  environmentId: string,
  projectId: string | null,
): TasksTabState {
  if (
    state.captureEnvironmentId === environmentId &&
    (state.captureProjectIds[environmentId] ?? null) === projectId
  )
    return state;
  return {
    ...state,
    captureEnvironmentId: environmentId,
    captureProjectIds: { ...state.captureProjectIds, [environmentId]: projectId },
  };
}

/** What the tab remembers on the device: ids only, never task content. */
export interface TasksTabState {
  /** The machine filter; null for every machine. */
  readonly environmentId: string | null;
  /** The project filter; null for every project. */
  readonly projectId: string | null;
  /** Completed tasks are listed in full rather than the latest few. */
  readonly showAllDone: boolean;
  /** The machine the last new task went to. */
  readonly captureEnvironmentId: string | null;
  /** The project the last new task on each machine went to. */
  readonly captureProjectIds: Readonly<Record<string, string | null>>;
}

export const DEFAULT_TASKS_TAB_STATE: TasksTabState = {
  environmentId: null,
  projectId: null,
  showAllDone: false,
  captureEnvironmentId: null,
  captureProjectIds: {},
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
  const captureProjectIds: Record<string, string | null> = {};
  const rawProjects = value.captureProjectIds;
  if (rawProjects !== null && typeof rawProjects === "object") {
    for (const [environmentId, projectId] of Object.entries(rawProjects).slice(0, 64)) {
      if (id(environmentId) !== null) captureProjectIds[environmentId] = id(projectId);
    }
  }
  return {
    environmentId: id(value.environmentId),
    projectId: id(value.projectId),
    showAllDone: value.showAllDone === true,
    captureEnvironmentId: id(value.captureEnvironmentId),
    captureProjectIds,
  };
}

/**
 * Picking another machine (or every machine) drops the project filter, which
 * named one of the old machine's.
 */
export function selectTaskMachine(
  state: TasksTabState,
  environmentId: string | null,
): TasksTabState {
  if (state.environmentId === environmentId) return state;
  return { ...state, environmentId, projectId: null };
}

/** Filters to one machine's project (picking the machine with it), or clears the project filter. */
export function selectTaskProject(
  state: TasksTabState,
  target: { readonly environmentId: string; readonly projectId: string } | null,
): TasksTabState {
  if (target === null) return state.projectId === null ? state : { ...state, projectId: null };
  return { ...state, environmentId: target.environmentId, projectId: target.projectId };
}

/** The project filter, kept only while the machine still has the project. */
export function resolveTaskProjectFilter(
  state: TasksTabState,
  projects: ReadonlyArray<{ readonly id: ProjectId }>,
): ProjectId | null {
  if (state.projectId === null) return null;
  return projects.find((project) => project.id === state.projectId)?.id ?? null;
}
