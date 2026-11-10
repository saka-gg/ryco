/**
 * The Desktop's saved copy of each machine's last read task list, so the
 * Tasks page paints a machine's tasks at launch and after a machine switch
 * instead of starting empty. Display only: a live read replaces it.
 *
 * Main keeps the copy encrypted beside the machine's recent conversations, so
 * it follows the same "keep recent conversations" setting (off: main deletes
 * it with the rest) and the same purges (a removed machine, another account).
 * The shape is the shared `SavedTaskList` the phone keeps too. Desktop-only
 * and loaded on demand by the task surfaces; never part of the hosted app.
 */
import type { EnvironmentId } from "@ryco/contracts";
import {
  selectLocalTasksEnvironment,
  useLocalTasksStore,
  type LocalTasksEnvironmentState,
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
  const state = selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId);
  if (!publish || readDesktopThreadContentCacheEnabled() !== true || state.readAt === null) return;
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
  return (
    at !== undefined &&
    selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).readAt === at
  );
}

/** Starts writing copies as task lists are read; idempotent. */
export function installDesktopTaskListCache(): void {
  if (installed || !bridge()?.publishDesktopTaskList) return;
  installed = true;
  const unsubscribeTasks = useLocalTasksStore.subscribe((state, previous) => {
    if (readDesktopThreadContentCacheEnabled() !== true) return;
    for (const [id, environment] of Object.entries(state.byEnvironment)) {
      if (environment === previous.byEnvironment[id]) continue;
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
      if (isDesktopTaskListCopy(environmentId)) useLocalTasksStore.getState().clear(environmentId);
    }
    hydratedAt.clear();
  });
  uninstall.push(unsubscribeTasks, unsubscribeSetting);
}

/**
 * Shows a machine's saved copy while nothing was read from it in this session
 * (before its first read lands, or while it is offline). A live read wins.
 */
export async function hydrateDesktopTaskList(environmentId: EnvironmentId): Promise<void> {
  const read = bridge()?.getDesktopTaskList;
  if (!read) return;
  if (selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).readAt !== null)
    return;
  if (!(await whenSettingKnown())) return;
  const saved = decodeSavedTaskList(await read(machineIdFor(environmentId)).catch(() => null));
  if (saved === null) return;
  // Recorded first: the store tells its subscribers while the copy is applied.
  hydratedAt.set(environmentId, saved.readAt);
  if (!applySavedTaskList(useLocalTasksStore, environmentId, saved)) {
    hydratedAt.delete(environmentId);
    return;
  }
  writtenFrom.set(
    environmentId,
    selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).tasks,
  );
}

/** Forgets the module's state (tests). */
export function resetDesktopTaskListCacheForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  writtenFrom.clear();
  hydratedAt.clear();
  for (const stop of uninstall.splice(0)) stop();
  installed = false;
}
