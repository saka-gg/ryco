import {
  selectLocalTasksEnvironment,
  useLocalTasksStore,
  type LocalTasksEnvironmentState,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId, LocalTask } from "@ryco/contracts";

import { mobileKV } from "../../platform/kv";
import {
  isPreferencesHydrated,
  isThreadContentCacheEnabled,
  subscribePreferences,
  whenPreferencesHydrated,
} from "../../state/preferencesStore";
import { onTaskCachePurge, TASK_CACHE_INDEX_KEY, TASK_CACHE_KEY_PREFIX } from "./taskCacheKeys";
import {
  applySavedTaskList,
  encodeSavedTaskList,
  parseSavedTaskList,
} from "@ryco/client-runtime/state/tasks/savedTaskList";

/**
 * The phone keeps each machine's last read task list so an offline machine's
 * tasks still show (read-only). It follows the device setting that keeps
 * recent conversations: off, nothing is written and every copy is removed;
 * a machine whose cached snapshot is purged (removed, revoked) loses its copy
 * too (`taskCacheKeys.ts`'s `purgeTaskCache`). The shared task store itself stays memory-only.
 */

const KEY_PREFIX = TASK_CACHE_KEY_PREFIX;
const INDEX_KEY = TASK_CACHE_INDEX_KEY;
/** A machine's copy is written this long after its tasks last changed. */
const WRITE_DELAY_MS = 2_000;

const timers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
const writtenFrom = new Map<EnvironmentId, Readonly<Record<string, LocalTask>>>();
/** The read time of the copy each machine's list was filled from, until a live read replaces it. */
const hydratedAt = new Map<EnvironmentId, number>();
let installed = false;

/**
 * The machine's tasks on screen are this device's copy, not a read in this
 * session: possibly cut short (`SAVED_TASK_LIST_MAX_TASKS`), so a task missing from
 * it is unknown rather than deleted.
 */
export function isOfflineTaskCopy(environmentId: EnvironmentId): boolean {
  const at = hydratedAt.get(environmentId);
  return (
    at !== undefined &&
    selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).readAt === at
  );
}

async function readIndex(): Promise<string[]> {
  try {
    const raw = await mobileKV.getItem(INDEX_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function writeIndex(ids: ReadonlyArray<string>): Promise<void> {
  await mobileKV.setItem(INDEX_KEY, JSON.stringify([...new Set(ids)]));
}

const enabled = () => isPreferencesHydrated() && isThreadContentCacheEnabled();

async function write(environmentId: EnvironmentId, state: LocalTasksEnvironmentState) {
  if (!enabled() || state.readAt === null) return;
  const encoded = encodeSavedTaskList(Object.values(state.tasks), state.readAt);
  if (encoded === null) {
    await mobileKV.removeItem(KEY_PREFIX + environmentId);
    return;
  }
  await mobileKV.setItem(KEY_PREFIX + environmentId, encoded);
  const index = await readIndex();
  if (!index.includes(environmentId)) await writeIndex([...index, environmentId]);
}

function schedule(environmentId: EnvironmentId): void {
  const pending = timers.get(environmentId);
  if (pending) clearTimeout(pending);
  timers.set(
    environmentId,
    setTimeout(() => {
      timers.delete(environmentId);
      const state = selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId);
      writtenFrom.set(environmentId, state.tasks);
      void write(environmentId, state).catch(() => undefined);
    }, WRITE_DELAY_MS),
  );
}

/** Removes every machine's copy (the setting was turned off). */
async function purgeAll(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  writtenFrom.clear();
  const index = await readIndex();
  await Promise.all(index.map((id) => mobileKV.removeItem(KEY_PREFIX + id)));
  await mobileKV.removeItem(INDEX_KEY);
}

function forget(environmentId: EnvironmentId): void {
  const timer = timers.get(environmentId);
  if (timer) clearTimeout(timer);
  timers.delete(environmentId);
  writtenFrom.delete(environmentId);
  // Like the threads' offline state: a list shown from the removed copy goes with it; a live one stays.
  if (isOfflineTaskCopy(environmentId)) useLocalTasksStore.getState().clear(environmentId);
  hydratedAt.delete(environmentId);
}

/** Starts writing copies as task lists are read; idempotent. */
export function installTaskCache(): void {
  if (installed) return;
  installed = true;
  onTaskCachePurge(forget);
  useLocalTasksStore.subscribe((state, previous) => {
    for (const [environmentId, environment] of Object.entries(state.byEnvironment)) {
      if (environment === previous.byEnvironment[environmentId]) continue;
      if (environment.readAt === null || environment.status !== "ready") continue;
      if (writtenFrom.get(environmentId as EnvironmentId) === environment.tasks) continue;
      schedule(environmentId as EnvironmentId);
    }
  });
  let wasEnabled = enabled();
  subscribePreferences(() => {
    const now = enabled();
    if (wasEnabled && !now) void purgeAll().catch(() => undefined);
    wasEnabled = now;
  });
}

/**
 * Shows a machine's last copy while nothing was read from it in this session
 * (offline, or before its first read lands). A live read replaces it.
 */
export async function hydrateTaskCache(environmentId: EnvironmentId): Promise<void> {
  // At a cold start the setting is still loading: wait for it rather than show nothing.
  await whenPreferencesHydrated();
  if (!enabled()) return;
  const before = selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId);
  if (before.readAt !== null) return;
  const stored = parseSavedTaskList(await mobileKV.getItem(KEY_PREFIX + environmentId));
  // A live read that landed meanwhile is newer than any copy: nothing is applied.
  if (stored === null || !applySavedTaskList(useLocalTasksStore, environmentId, stored)) return;
  hydratedAt.set(environmentId, stored.readAt);
  writtenFrom.set(
    environmentId,
    selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).tasks,
  );
}
