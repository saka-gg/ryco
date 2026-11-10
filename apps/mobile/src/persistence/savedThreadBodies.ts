import { useSyncExternalStore } from "react";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";

/**
 * The thread screens' side of the saved bodies (recent text and open cards
 * of a thread, `environmentSnapshotPersistence.ts`). Kept apart from the
 * snapshot cache, which loads lazily at startup: a screen asks for a thread's
 * saved body here, and reads whether one is on its way, without loading the
 * cache module.
 */

type Loader = (environmentId: EnvironmentId, threadId: ThreadId) => Promise<void>;

/** Requests made before the cache has started; only the latest few matter. */
const MAX_WAITING_REQUESTS = 8;

let loader: Loader | null = null;
let waiting: Array<readonly [EnvironmentId, ThreadId]> = [];
/** Threads that have a saved body, by machine. */
let saved = new Map<EnvironmentId, ReadonlySet<ThreadId>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function load(environmentId: EnvironmentId, threadId: ThreadId, run: Loader): void {
  void run(environmentId, threadId).catch((error: unknown) => {
    console.warn("[snapshot-cache] could not read a saved conversation", error);
    forgetSavedThreadBody(environmentId, threadId);
  });
}

/**
 * Shows the thread's saved body, if it has one and live data has not given
 * it a body yet: the thread is opening (its screen, a notification) or about
 * to (a finger on its row).
 */
export function requestSavedThreadBody(environmentId: EnvironmentId, threadId: ThreadId): void {
  if (loader !== null) {
    load(environmentId, threadId, loader);
    return;
  }
  waiting = [...waiting, [environmentId, threadId] as const].slice(-MAX_WAITING_REQUESTS);
}

/** The snapshot cache's reader; requests made before it was installed run now. */
export function installSavedThreadBodyLoader(next: Loader | null): void {
  loader = next;
  if (next === null) {
    waiting = [];
    return;
  }
  const pending = waiting;
  waiting = [];
  for (const [environmentId, threadId] of pending) load(environmentId, threadId, next);
}

/** Every thread with a saved body (read at launch, or none). */
export function replaceSavedThreadBodyKeys(
  keys: Iterable<readonly [EnvironmentId, ThreadId]>,
): void {
  const next = new Map<EnvironmentId, Set<ThreadId>>();
  for (const [environmentId, threadId] of keys) {
    let threads = next.get(environmentId);
    if (threads === undefined) next.set(environmentId, (threads = new Set()));
    threads.add(threadId);
  }
  if (next.size === 0 && saved.size === 0) return;
  saved = next;
  notify();
}

/** One machine's threads with a saved body, after a capture wrote them. */
export function setEnvironmentSavedThreadBodyKeys(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  const current = saved.get(environmentId) ?? new Set<ThreadId>();
  if (current.size === threadIds.length && threadIds.every((threadId) => current.has(threadId))) {
    return;
  }
  const next = new Map(saved);
  if (threadIds.length === 0) next.delete(environmentId);
  else next.set(environmentId, new Set(threadIds));
  saved = next;
  notify();
}

export function forgetEnvironmentSavedThreadBodies(environmentId: EnvironmentId): void {
  setEnvironmentSavedThreadBodyKeys(environmentId, []);
}

/** The thread has no saved body to show after all (none stored, or it did not decode). */
export function forgetSavedThreadBody(environmentId: EnvironmentId, threadId: ThreadId): void {
  const current = saved.get(environmentId);
  if (current === undefined || !current.has(threadId)) return;
  setEnvironmentSavedThreadBodyKeys(
    environmentId,
    [...current].filter((id) => id !== threadId),
  );
}

export function hasSavedThreadBody(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return saved.get(environmentId)?.has(threadId) === true;
}

/**
 * Whether the thread has a saved body: while its screen has no messages yet,
 * they are on their way, so it shows no empty state in the meantime.
 */
export function useHasSavedThreadBody(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasSavedThreadBody(environmentId, threadId),
    () => hasSavedThreadBody(environmentId, threadId),
  );
}
