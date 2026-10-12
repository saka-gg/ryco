import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { THREAD_DETAIL_NAVIGATION_RETAIN_MS } from "./threadDetailRetain";

// Kept in a dependency-free module so pure intent logic can read it without
// pulling in the environment runtime.
export { THREAD_DETAIL_NAVIGATION_RETAIN_MS } from "./threadDetailRetain";

interface NavigationRetain {
  readonly release: () => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

/** One navigation retain per thread; see `prewarmThreadDetailSubscription`. */
const navigationRetains = new Map<string, NavigationRetain>();

const retainKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

function releaseByKey(key: string): void {
  const retain = navigationRetains.get(key);
  if (!retain) return;
  navigationRetains.delete(key);
  globalThis.clearTimeout(retain.timer);
  retain.release();
}

/**
 * Starts a thread's detail subscription at navigation (or intent) time, so the
 * thread window request runs in parallel with the route chunk and the first
 * render instead of after the view's mount effect.
 *
 * The retain is taken synchronously and is ref-counted with the view's own,
 * so it never opens a second stream. Each thread holds at most one navigation
 * retain: a repeated call (the welcome prewarm followed by the route loader,
 * or a loader re-run) refreshes its deadline instead of stacking retains.
 */
export function prewarmThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  retainMs: number = THREAD_DETAIL_NAVIGATION_RETAIN_MS,
): void {
  const key = retainKey(environmentId, threadId);
  const existing = navigationRetains.get(key);
  if (existing) {
    globalThis.clearTimeout(existing.timer);
    existing.timer = globalThis.setTimeout(() => releaseByKey(key), retainMs);
    return;
  }
  let release: () => void;
  try {
    release = retainThreadDetailSubscription(environmentId, threadId);
  } catch {
    // Prewarming is advisory; the thread view's own retain reports failures.
    return;
  }
  navigationRetains.set(key, {
    release,
    timer: globalThis.setTimeout(() => releaseByKey(key), retainMs),
  });
}

/**
 * Ends the navigation retain of one thread: its view has mounted and holds its
 * own retain, so the subscription no longer needs the bridge.
 */
export function releaseThreadDetailPrewarm(environmentId: EnvironmentId, threadId: ThreadId): void {
  releaseByKey(retainKey(environmentId, threadId));
}

/**
 * Ends every navigation retain except `keep`'s: the thread route settled on
 * `keep` (or on nothing, when it left), so retains taken for superseded
 * navigations are not held until their deadline.
 */
export function releaseThreadDetailPrewarmsExcept(
  keep: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): void {
  const keepKey = keep ? retainKey(keep.environmentId, keep.threadId) : null;
  // Deleting the entry being visited is safe while iterating a Map.
  for (const key of navigationRetains.keys()) {
    if (key !== keepKey) releaseByKey(key);
  }
}

/** Releases every navigation retain, so no test inherits another's subscriptions. */
export function resetThreadDetailPrewarmsForTests(): void {
  for (const key of [...navigationRetains.keys()]) releaseByKey(key);
}
