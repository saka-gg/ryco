/**
 * The Desktop's saved copy of each machine's last read task list, so the
 * Tasks page paints a machine's tasks at launch and after a machine switch
 * instead of starting empty. Display only: a live read replaces it.
 *
 * Main keeps the copy encrypted beside the machine's recent conversations, so
 * it follows the same "keep recent conversations" setting (off: main deletes
 * it with the rest) and the same purges (a removed machine, another account).
 * The shape is the shared `SavedTaskList` the phone keeps too. Desktop-only:
 * loaded with the conversation publisher once the setting keeps copies, never
 * part of the hosted app. It watches the task store, so no task surface loads
 * it: a machine whose tasks a surface starts reading is painted from its copy.
 */
import type { EnvironmentId } from "@ryco/contracts";
import type {
  LocalTasksEnvironmentState,
  LocalTasksStoreState,
} from "@ryco/client-runtime/state/tasks";
import {
  applySavedTaskList,
  boundSavedTaskList,
  decodeSavedTaskList,
} from "@ryco/client-runtime/state/tasks/savedTaskList";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  readDesktopThreadContentCacheEnabled,
  readDesktopWorkspaceState,
  subscribeDesktopThreadContentCacheEnabled,
} from "./desktopWorkspace";

/** A machine's copy is written this long after its tasks last changed. */
export const DESKTOP_TASK_LIST_WRITE_DELAY_MS = 2_000;

const timers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
/** The task map each machine's copy was last written from (or filled from). */
const writtenFrom = new Map<EnvironmentId, LocalTasksEnvironmentState["tasks"]>();
/** The read time of the copy each machine's list was filled from, until a live read replaces it. */
const hydratedAt = new Map<EnvironmentId, number>();
let installed = false;
/**
 * The shared task store, taken from the task surfaces' chunk at install. A
 * static import of the task state from this lazy chunk would make the bundler
 * split the task store out of the chat route's chunk into one of its own,
 * which every chat would then load.
 */
interface TasksStore {
  readonly getState: () => LocalTasksStoreState;
  readonly subscribe: (
    listener: (state: LocalTasksStoreState, previous: LocalTasksStoreState) => void,
  ) => () => void;
}
let tasksStore: TasksStore | null = null;

/** A machine's slice of the task store, or undefined while nothing was asked for it. */
function environmentOf(environmentId: EnvironmentId): LocalTasksEnvironmentState | undefined {
  return tasksStore?.getState().byEnvironment[environmentId];
}
const uninstall: Array<() => void> = [];

function bridge() {
  return globalThis.window?.desktopBridge;
}

/**
 * The machine main keeps the copy under. The local machine's tasks are read
 * from the primary environment; main knows that machine by its catalog id.
 */
function machineIdFor(environmentId: EnvironmentId): EnvironmentId {
  const primary = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const local = readDesktopWorkspaceState().localEnvironmentId;
  return primary !== null && environmentId === primary && local !== null ? local : environmentId;
}

/** The setting, once main answered it (it is read at the bridge's start). */
function whenSettingKnown(): Promise<boolean> {
  const known = readDesktopThreadContentCacheEnabled();
  if (known !== null) return Promise.resolve(known);
  return new Promise((resolve) => {
    const unsubscribe = subscribeDesktopThreadContentCacheEnabled(() => {
      const value = readDesktopThreadContentCacheEnabled();
      if (value === null) return;
      unsubscribe();
      resolve(value);
    });
  });
}

function write(environmentId: EnvironmentId): void {
  const publish = bridge()?.publishDesktopTaskList;
  const state = environmentOf(environmentId);
  if (
    !publish ||
    readDesktopThreadContentCacheEnabled() !== true ||
    state === undefined ||
    state.readAt === null
  )
    return;
  writtenFrom.set(environmentId, state.tasks);
  // Too large for a copy: the kept one goes rather than staying stale.
  const list = boundSavedTaskList(Object.values(state.tasks), state.readAt);
  void publish(machineIdFor(environmentId), list).catch(() => undefined);
}

function schedule(environmentId: EnvironmentId): void {
  const pending = timers.get(environmentId);
  if (pending !== undefined) clearTimeout(pending);
  timers.set(
    environmentId,
    setTimeout(() => {
      timers.delete(environmentId);
      write(environmentId);
    }, DESKTOP_TASK_LIST_WRITE_DELAY_MS),
  );
}

/** Whether the machine's tasks on screen are this device's copy rather than a read in this session. */
export function isDesktopTaskListCopy(environmentId: EnvironmentId): boolean {
  const at = hydratedAt.get(environmentId);
  return at !== undefined && environmentOf(environmentId)?.readAt === at;
}

/**
 * Starts writing copies as task lists are read, and painting a machine's copy
 * when a surface starts reading its tasks; idempotent. `store` is for tests.
 */
export async function installDesktopTaskListCache(store?: TasksStore): Promise<void> {
  if (installed || !bridge()?.publishDesktopTaskList) return;
  installed = true;
  // From the task surfaces' own chunk, which holds the store already.
  tasksStore = store ?? (await import("../components/tasks/useLocalTasks")).useLocalTasksStore;
  const tasks = tasksStore;
  const unsubscribeTasks = tasks.subscribe((state, previous) => {
    if (readDesktopThreadContentCacheEnabled() !== true) return;
    for (const [id, environment] of Object.entries(state.byEnvironment)) {
      if (environment === previous.byEnvironment[id]) continue;
      if (environment.readAt === null) {
        // A surface started reading this machine's tasks: paint its copy meanwhile.
        hydrateOnce(id as EnvironmentId);
        continue;
      }
      if (environment.readAt === null || environment.status !== "ready") continue;
      const environmentId = id as EnvironmentId;
      if (writtenFrom.get(environmentId) === environment.tasks) continue;
      // The list painted from the copy is not written back.
      if (hydratedAt.get(environmentId) === environment.readAt) continue;
      schedule(environmentId);
    }
  });
  const unsubscribeSetting = subscribeDesktopThreadContentCacheEnabled(() => {
    if (readDesktopThreadContentCacheEnabled() !== false) return;
    // Main deleted every copy; what is shown from one goes with it, a live list stays.
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    writtenFrom.clear();
    for (const environmentId of hydratedAt.keys()) {
      if (isDesktopTaskListCopy(environmentId)) tasks.getState().clear(environmentId);
    }
    hydratedAt.clear();
  });
  uninstall.push(unsubscribeTasks, unsubscribeSetting);
  // Machines whose tasks were asked for before this module loaded.
  for (const [id, environment] of Object.entries(tasks.getState().byEnvironment)) {
    if (environment.readAt === null) hydrateOnce(id as EnvironmentId);
  }
}

/** Machines whose copy was asked for in this session: each is painted at most once. */
const hydrationRequested = new Set<EnvironmentId>();
function hydrateOnce(environmentId: EnvironmentId): void {
  if (hydrationRequested.has(environmentId)) return;
  hydrationRequested.add(environmentId);
  void hydrateDesktopTaskList(environmentId).catch(() => undefined);
}

/**
 * Shows a machine's saved copy while nothing was read from it in this session
 * (before its first read lands, or while it is offline). A live read wins.
 */
export async function hydrateDesktopTaskList(environmentId: EnvironmentId): Promise<void> {
  const read = bridge()?.getDesktopTaskList;
  if (!read) return;
  const store = tasksStore;
  if (store === null || (environmentOf(environmentId)?.readAt ?? null) !== null) return;
  if (!(await whenSettingKnown())) return;
  const saved = decodeSavedTaskList(await read(machineIdFor(environmentId)).catch(() => null));
  if (saved === null) return;
  // Recorded first: the store tells its subscribers while the copy is applied.
  hydratedAt.set(environmentId, saved.readAt);
  if (!applySavedTaskList(store, environmentId, saved)) {
    hydratedAt.delete(environmentId);
    return;
  }
  const shown = environmentOf(environmentId);
  if (shown !== undefined) writtenFrom.set(environmentId, shown.tasks);
}

/** Forgets the module's state (tests). */
export function resetDesktopTaskListCacheForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  writtenFrom.clear();
  hydratedAt.clear();
  hydrationRequested.clear();
  for (const stop of uninstall.splice(0)) stop();
  installed = false;
  tasksStore = null;
}
