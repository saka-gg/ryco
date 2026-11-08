import type { EnvironmentId } from "@ryco/contracts";

import { mobileKV } from "../../platform/kv";

/**
 * Where the phone keeps its offline copies of machines' task lists
 * (`taskCache.ts`), and their removal, kept apart so the snapshot cache can
 * purge a machine's copy without loading the task runtime at startup.
 */

export const TASK_CACHE_KEY_PREFIX = "ryco.tasks.cache.v1:";
export const TASK_CACHE_INDEX_KEY = "ryco.tasks.cache.v1.index";

const purgeListeners = new Set<(environmentId: EnvironmentId) => void>();

/** Called before a machine's copy is removed, so a pending write of it is dropped. */
export function onTaskCachePurge(listener: (environmentId: EnvironmentId) => void): () => void {
  purgeListeners.add(listener);
  return () => purgeListeners.delete(listener);
}

/** Removes one machine's copy: its cached content was purged (removed, revoked). */
export function purgeTaskCache(environmentId: EnvironmentId): void {
  for (const listener of purgeListeners) listener(environmentId);
  void mobileKV.removeItem(TASK_CACHE_KEY_PREFIX + environmentId).catch(() => undefined);
}
