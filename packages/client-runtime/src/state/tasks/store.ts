import type {
  EnvironmentId,
  LocalTask,
  LocalTaskDelegation,
  LocalTaskStatus,
  ProjectId,
} from "@ryco/contracts";
import { aggregateLocalTaskStatus } from "@ryco/shared/localTasks";
import { create } from "zustand";

import { compareDoneTasks, compareOpenTasks } from "./logic.ts";
import type { LocalTaskOptimisticStart, LocalTaskOverlay, LocalTaskView } from "./types.ts";

export type LocalTasksStatus = "idle" | "loading" | "ready" | "error";

export interface LocalTasksError {
  /**
   * `unsupported`: the node has no task methods; `forbidden`: the node refuses
   * them to this session (not its owner); `read`: the last read failed.
   */
  readonly kind: "unsupported" | "forbidden" | "read";
  readonly message: string;
}

export interface LocalTasksEnvironmentState {
  /** The node's tasks by id; kept through a failed refresh. */
  readonly tasks: Readonly<Record<string, LocalTask>>;
  /** The ids of `tasks` in the node's list order. */
  readonly order: ReadonlyArray<string>;
  readonly status: LocalTasksStatus;
  readonly error: LocalTasksError | null;
  /** When the last read landed (ms since the epoch); `null` before the first. */
  readonly readAt: number | null;
  /**
   * The last read stopped before the node's last page (`LOCAL_TASKS_MAX_PAGES`):
   * tasks past it were kept as they were, not re-read.
   */
  readonly truncated: boolean;
  /** What this client changed and the node has not confirmed, by task id. */
  readonly overlays: Readonly<Record<string, LocalTaskOverlay>>;
  /**
   * Counts tasks applied or removed outside a read. A read records it when it
   * starts, so it can tell which of its tasks this client has heard about
   * since (see `applyList`).
   */
  readonly writeEpoch: number;
  /** The `writeEpoch` at which each task was last applied or removed outside a read. */
  readonly touchedAt: Readonly<Record<string, number>>;
}

export const EMPTY_LOCAL_TASK_OVERLAY: LocalTaskOverlay = {
  patch: null,
  patchedAt: null,
  hidden: false,
  optimisticStarts: [],
  created: null,
};

export const EMPTY_LOCAL_TASKS_STATE: LocalTasksEnvironmentState = {
  tasks: {},
  order: [],
  status: "idle",
  error: null,
  readAt: null,
  truncated: false,
  overlays: {},
  writeEpoch: 0,
  touchedAt: {},
};

export interface LocalTasksReadStamp {
  /** The environment's `writeEpoch` when the read started. */
  readonly since: number;
  readonly readAt: number;
  /**
   * The last task id a read that stopped early covers (the node lists ids in
   * ascending order); `null` or absent when it read every page.
   */
  readonly coveredThrough?: string | null;
}

export interface LocalTasksStoreState {
  readonly byEnvironment: Readonly<Record<string, LocalTasksEnvironmentState>>;
  /**
   * Nodes that refused this session their tasks. Kept apart from
   * `byEnvironment`, which a release clears: surfaces hide on it and stop
   * reading, so it must outlive the read that learned it, or showing them again
   * would read, be refused and hide them in a loop. A successful read lifts it.
   */
  readonly forbidden: Readonly<Record<string, true>>;
  readonly setLoading: (environmentId: EnvironmentId) => void;
  /**
   * Publishes a full read. It replaces the task list, except where this client
   * heard something newer after the read started: a task applied since is
   * kept even when the read lacks it, and one removed since stays removed. A
   * read that stopped early (`coveredThrough`) says nothing about the tasks
   * past it, so those are kept as they were.
   */
  readonly applyList: (
    environmentId: EnvironmentId,
    tasks: ReadonlyArray<LocalTask>,
    stamp: LocalTasksReadStamp,
  ) => void;
  /** Publishes one task the node returned; an older revision only adds starts it lacks. */
  readonly applyTask: (environmentId: EnvironmentId, task: LocalTask) => void;
  readonly removeTask: (environmentId: EnvironmentId, taskId: string) => void;
  readonly setOverlay: (
    environmentId: EnvironmentId,
    taskId: string,
    update: (overlay: LocalTaskOverlay) => LocalTaskOverlay,
  ) => void;
  readonly clearOverlay: (environmentId: EnvironmentId, taskId: string) => void;
  readonly setError: (environmentId: EnvironmentId, error: LocalTasksError) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
}

function sameDelegations(
  left: ReadonlyArray<LocalTaskDelegation>,
  right: ReadonlyArray<LocalTaskDelegation>,
): boolean {
  return (
    left.length === right.length &&
    left.every((delegation, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        delegation.commandId === other.commandId &&
        delegation.status === other.status &&
        delegation.dispatched === other.dispatched &&
        delegation.error === other.error
      );
    })
  );
}

/**
 * Starts are append-only on the node, so the starts of both copies are
 * united by command id (the winner's copy of a shared one stays), oldest first.
 */
function withDelegationsOf(winner: LocalTask, other: LocalTask | undefined): LocalTask {
  if (!other || other.delegations.length === 0) return winner;
  const known = new Set(winner.delegations.map((delegation) => delegation.commandId));
  const missing = other.delegations.filter((delegation) => !known.has(delegation.commandId));
  if (missing.length === 0) return winner;
  return {
    ...winner,
    delegations: [...winner.delegations, ...missing].toSorted(
      (left, right) => left.sequence - right.sequence,
    ),
  };
}

/** The higher revision wins (a tie goes to the newer answer); an unchanged task keeps its object. */
function mergeTask(current: LocalTask | undefined, incoming: LocalTask): LocalTask {
  if (!current) return incoming;
  if (incoming.revision < current.revision) return withDelegationsOf(current, incoming);
  const next = withDelegationsOf(incoming, current);
  return next.revision === current.revision &&
    next.updatedAt === current.updatedAt &&
    next.status === current.status &&
    sameDelegations(next.delegations, current.delegations)
    ? current
    : next;
}

function isEmptyOverlay(overlay: LocalTaskOverlay): boolean {
  return (
    overlay.patch === null &&
    !overlay.hidden &&
    overlay.optimisticStarts.length === 0 &&
    overlay.created === null
  );
}

function unconfirmedStarts(
  starts: ReadonlyArray<LocalTaskOptimisticStart>,
  task: LocalTask,
): ReadonlyArray<LocalTaskOptimisticStart> {
  if (starts.length === 0 || task.delegations.length === 0) return starts;
  const known = new Set(task.delegations.map((delegation) => delegation.commandId));
  const left = starts.filter((start) => !known.has(start.commandId));
  return left.length === starts.length ? starts : left;
}

/**
 * Drops what the node now confirms: starts it knows, and the optimistic copy
 * of a task it has. An overlay on a task that is gone (and was not created
 * here) has nothing left to show.
 */
function reconcileOverlay(
  overlay: LocalTaskOverlay,
  task: LocalTask | undefined,
): LocalTaskOverlay | null {
  if (!task) return overlay.created ? overlay : null;
  const optimisticStarts = unconfirmedStarts(overlay.optimisticStarts, task);
  if (optimisticStarts === overlay.optimisticStarts && overlay.created === null) return overlay;
  const next = { ...overlay, optimisticStarts, created: null };
  return isEmptyOverlay(next) ? null : next;
}

function reconcileOverlays(
  overlays: Readonly<Record<string, LocalTaskOverlay>>,
  tasks: Readonly<Record<string, LocalTask>>,
): Readonly<Record<string, LocalTaskOverlay>> {
  let next: Record<string, LocalTaskOverlay> | null = null;
  for (const [taskId, overlay] of Object.entries(overlays)) {
    const reconciled = reconcileOverlay(overlay, tasks[taskId]);
    if (reconciled === overlay) continue;
    next ??= { ...overlays };
    if (reconciled) next[taskId] = reconciled;
    else delete next[taskId];
  }
  return next ?? overlays;
}

function sameIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function patchEnvironment(
  state: LocalTasksStoreState,
  environmentId: EnvironmentId,
  update: (current: LocalTasksEnvironmentState) => LocalTasksEnvironmentState,
): Partial<LocalTasksStoreState> | LocalTasksStoreState {
  const current = state.byEnvironment[environmentId] ?? EMPTY_LOCAL_TASKS_STATE;
  const next = update(current);
  return next === current
    ? state
    : { byEnvironment: { ...state.byEnvironment, [environmentId]: next } };
}

function applyListTo(
  current: LocalTasksEnvironmentState,
  incoming: ReadonlyArray<LocalTask>,
  stamp: LocalTasksReadStamp,
): LocalTasksEnvironmentState {
  const touchedSince = (taskId: string) => (current.touchedAt[taskId] ?? -1) > stamp.since;
  const coveredThrough = stamp.coveredThrough ?? null;
  // Ids compare as the node orders them: they are ASCII, so code units match its bytes.
  const unread = (taskId: string) => coveredThrough !== null && taskId > coveredThrough;
  const tasks: Record<string, LocalTask> = {};
  const order: string[] = [];
  let reused = true;
  for (const task of incoming) {
    const existing = current.tasks[task.taskId];
    // Listed, but removed here after the read started.
    if (task.taskId in tasks || (!existing && touchedSince(task.taskId))) continue;
    const next = mergeTask(existing, task);
    if (next !== existing) reused = false;
    tasks[task.taskId] = next;
    order.push(task.taskId);
  }
  // Applied here after the read started (the read could not have seen it), or
  // past where a read that stopped early got to.
  for (const taskId of current.order) {
    const existing = current.tasks[taskId];
    if (taskId in tasks || !existing || !(touchedSince(taskId) || unread(taskId))) continue;
    tasks[taskId] = existing;
    order.push(taskId);
  }
  // Only the next read can be older than these marks, and it starts later.
  const touchedAt: Record<string, number> = {};
  for (const [taskId, epoch] of Object.entries(current.touchedAt))
    if (epoch > stamp.since) touchedAt[taskId] = epoch;
  const unchanged = reused && sameIds(order, current.order);
  const nextTasks = unchanged ? current.tasks : tasks;
  return {
    ...current,
    tasks: nextTasks,
    order: unchanged ? current.order : order,
    status: "ready",
    error: null,
    readAt: stamp.readAt,
    truncated: coveredThrough !== null,
    overlays: reconcileOverlays(current.overlays, nextTasks),
    touchedAt,
  };
}

function applyTaskTo(
  current: LocalTasksEnvironmentState,
  task: LocalTask,
): LocalTasksEnvironmentState {
  const existing = current.tasks[task.taskId];
  const next = mergeTask(existing, task);
  const writeEpoch = current.writeEpoch + 1;
  const overlay = current.overlays[task.taskId];
  const reconciled = overlay ? reconcileOverlay(overlay, next) : undefined;
  let overlays = current.overlays;
  if (overlay && reconciled !== overlay) {
    const copy = { ...overlays };
    if (reconciled) copy[task.taskId] = reconciled;
    else delete copy[task.taskId];
    overlays = copy;
  }
  return {
    ...current,
    tasks: next === existing ? current.tasks : { ...current.tasks, [task.taskId]: next },
    order: existing ? current.order : [...current.order, task.taskId],
    overlays,
    writeEpoch,
    touchedAt: { ...current.touchedAt, [task.taskId]: writeEpoch },
  };
}

/**
 * Local tasks by environment. Memory only: titles, notes and links are
 * node-owned content and never reach persistent client storage. The writers
 * are the environment's retained sync (`retainLocalTasks`) and the task
 * writer (`createLocalTaskWriter`), which also owns the overlays.
 */
export const useLocalTasksStore = create<LocalTasksStoreState>((set) => ({
  byEnvironment: {},
  forbidden: {},
  setLoading: (environmentId) =>
    set((state) =>
      patchEnvironment(state, environmentId, (current) =>
        current.status === "loading" ? current : { ...current, status: "loading" },
      ),
    ),
  applyList: (environmentId, tasks, stamp) =>
    set((state) => {
      const next = patchEnvironment(state, environmentId, (current) =>
        applyListTo(current, tasks, stamp),
      );
      if (!(environmentId in state.forbidden)) return next;
      const forbidden = { ...state.forbidden };
      delete forbidden[environmentId];
      return { ...next, forbidden };
    }),
  applyTask: (environmentId, task) =>
    set((state) => patchEnvironment(state, environmentId, (current) => applyTaskTo(current, task))),
  removeTask: (environmentId, taskId) =>
    set((state) =>
      patchEnvironment(state, environmentId, (current) => {
        const writeEpoch = current.writeEpoch + 1;
        const tasks = { ...current.tasks };
        delete tasks[taskId];
        const overlays = { ...current.overlays };
        delete overlays[taskId];
        return {
          ...current,
          tasks,
          order: current.order.filter((id) => id !== taskId),
          overlays,
          writeEpoch,
          touchedAt: { ...current.touchedAt, [taskId]: writeEpoch },
        };
      }),
    ),
  setOverlay: (environmentId, taskId, update) =>
    set((state) =>
      patchEnvironment(state, environmentId, (current) => {
        const overlay = current.overlays[taskId] ?? EMPTY_LOCAL_TASK_OVERLAY;
        const next = update(overlay);
        if (next === overlay) return current;
        const overlays = { ...current.overlays };
        if (isEmptyOverlay(next)) delete overlays[taskId];
        else overlays[taskId] = next;
        return { ...current, overlays };
      }),
    ),
  clearOverlay: (environmentId, taskId) =>
    set((state) =>
      patchEnvironment(state, environmentId, (current) => {
        if (!(taskId in current.overlays)) return current;
        const overlays = { ...current.overlays };
        delete overlays[taskId];
        return { ...current, overlays };
      }),
    ),
  setError: (environmentId, error) =>
    set((state) => {
      const next = patchEnvironment(state, environmentId, (current) => ({
        ...current,
        status: "error",
        error,
      }));
      return error.kind === "forbidden" && !(environmentId in state.forbidden)
        ? { ...next, forbidden: { ...state.forbidden, [environmentId]: true } }
        : next;
    }),
  clear: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.byEnvironment)) return state;
      const byEnvironment = { ...state.byEnvironment };
      delete byEnvironment[environmentId];
      return { byEnvironment };
    }),
}));

type LocalTasksStoreSlice = Pick<LocalTasksStoreState, "byEnvironment">;

/** The node refused this session its tasks (see `LocalTasksStoreState.forbidden`). */
export function selectLocalTasksForbidden(
  state: Pick<LocalTasksStoreState, "forbidden">,
  environmentId: EnvironmentId,
): boolean {
  return environmentId in state.forbidden;
}

export function selectLocalTasksEnvironment(
  state: LocalTasksStoreSlice,
  environmentId: EnvironmentId,
): LocalTasksEnvironmentState {
  return state.byEnvironment[environmentId] ?? EMPTY_LOCAL_TASKS_STATE;
}

const EMPTY_STARTS: ReadonlyArray<LocalTaskOptimisticStart> = [];
const viewCache = new WeakMap<
  LocalTask,
  { readonly overlay: LocalTaskOverlay | undefined; readonly view: LocalTaskView }
>();

/** The node's rule (`done`, then `unavailable`, then the chats), over the overlaid task. */
function overlaidStatus(
  base: LocalTask,
  overlay: LocalTaskOverlay | undefined,
  starts: ReadonlyArray<LocalTaskOptimisticStart>,
): LocalTaskStatus {
  const patch = overlay?.patch;
  if ((patch?.state ?? base.state) === "done") return "done";
  const projectChanged = patch?.projectId !== undefined && patch.projectId !== base.projectId;
  if (base.status === "unavailable" && !projectChanged) return "unavailable";
  const statuses = base.delegations.map((delegation) => delegation.status);
  if (starts.length > 0) statuses.push("starting");
  return aggregateLocalTaskStatus(statuses);
}

function buildTaskView(base: LocalTask, overlay: LocalTaskOverlay | undefined): LocalTaskView {
  const optimisticStarts = overlay
    ? unconfirmedStarts(overlay.optimisticStarts, base)
    : EMPTY_STARTS;
  const patchedAt = overlay?.patchedAt ?? null;
  return {
    ...base,
    ...overlay?.patch,
    status: overlaidStatus(base, overlay, optimisticStarts),
    updatedAt: patchedAt !== null && patchedAt > base.updatedAt ? patchedAt : base.updatedAt,
    optimisticStarts,
    creating: overlay?.created === base,
    saving: (overlay?.patch ?? null) !== null,
  };
}

function taskViewIn(
  environment: LocalTasksEnvironmentState,
  taskId: string,
): LocalTaskView | undefined {
  const overlay = environment.overlays[taskId];
  const base = environment.tasks[taskId] ?? overlay?.created ?? undefined;
  if (!base || overlay?.hidden) return undefined;
  const cached = viewCache.get(base);
  if (cached && cached.overlay === overlay) return cached.view;
  const view = buildTaskView(base, overlay);
  viewCache.set(base, { overlay, view });
  return view;
}

/**
 * A task as this client shows it: the node's task (or the copy created here)
 * with this client's unconfirmed changes applied; `undefined` while it is
 * being deleted or when there is no such task. Stable while neither changes.
 */
export function selectTaskView(
  state: LocalTasksStoreSlice,
  environmentId: EnvironmentId,
  taskId: string,
): LocalTaskView | undefined {
  return taskViewIn(selectLocalTasksEnvironment(state, environmentId), taskId);
}

function forEachTaskView(
  environment: LocalTasksEnvironmentState,
  visit: (view: LocalTaskView) => void,
): void {
  for (const taskId of environment.order) {
    const view = taskViewIn(environment, taskId);
    if (view) visit(view);
  }
  for (const [taskId, overlay] of Object.entries(environment.overlays)) {
    if (!overlay.created || taskId in environment.tasks) continue;
    const view = taskViewIn(environment, taskId);
    if (view) visit(view);
  }
}

function stableList<T>(previous: ReadonlyArray<T> | undefined, next: T[]): ReadonlyArray<T> {
  return previous &&
    previous.length === next.length &&
    previous.every((item, index) => item === next[index])
    ? previous
    : next;
}

export interface LocalTaskIdsFilter {
  /** Completed tasks rather than open ones. */
  readonly done: boolean;
  /** One project's tasks; `null` for every task. */
  readonly projectId: ProjectId | null;
}

const taskIdsCache = new Map<
  string,
  { readonly environment: LocalTasksEnvironmentState; readonly ids: ReadonlyArray<string> }
>();

/**
 * The ids of the open or completed tasks shown, open ones newest first and
 * completed ones most recently changed first. The same array comes back while
 * the list it describes is unchanged, so a list component re-renders only when
 * a task joins, leaves or moves.
 */
export function selectTaskIds(
  state: LocalTasksStoreSlice,
  environmentId: EnvironmentId,
  filter: LocalTaskIdsFilter,
): ReadonlyArray<string> {
  const environment = selectLocalTasksEnvironment(state, environmentId);
  const key = `${environmentId}\u0000${filter.done ? "done" : "open"}\u0000${filter.projectId ?? ""}`;
  const cached = taskIdsCache.get(key);
  if (cached?.environment === environment) return cached.ids;
  const views: LocalTaskView[] = [];
  forEachTaskView(environment, (view) => {
    if ((view.state === "done") !== filter.done) return;
    if (filter.projectId !== null && view.projectId !== filter.projectId) return;
    views.push(view);
  });
  views.sort(filter.done ? compareDoneTasks : compareOpenTasks);
  const ids = stableList(
    cached?.ids,
    views.map((view) => view.taskId),
  );
  taskIdsCache.set(key, { environment, ids });
  return ids;
}

const openViewsCache = new Map<
  string,
  {
    readonly environment: LocalTasksEnvironmentState;
    readonly views: ReadonlyArray<LocalTaskView>;
  }
>();

/**
 * Every open task as shown, newest first, for whole-list rules such as the
 * "needs you" badge (`countTasksNeedingUser`). Stable while no open task changes.
 */
export function selectOpenTaskViews(
  state: LocalTasksStoreSlice,
  environmentId: EnvironmentId,
): ReadonlyArray<LocalTaskView> {
  const environment = selectLocalTasksEnvironment(state, environmentId);
  const cached = openViewsCache.get(environmentId);
  if (cached?.environment === environment) return cached.views;
  const views: LocalTaskView[] = [];
  forEachTaskView(environment, (view) => {
    if (view.state !== "done") views.push(view);
  });
  views.sort(compareOpenTasks);
  const stable = stableList(cached?.views, views);
  openViewsCache.set(environmentId, { environment, views: stable });
  return stable;
}
