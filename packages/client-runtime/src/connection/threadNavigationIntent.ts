import type { ScopedThreadRef } from "@ryco/contracts";

// Navigation intent for thread rows, shared by web's sidebar and inbox rows and
// the phone's Home rows: a press (or a resting pointer) starts the thread's
// detail subscription, speculatively, so its history request overlaps the
// navigation instead of starting from the thread view's mount.

/**
 * How long a navigation intent keeps the thread's detail subscription: the
 * same window as web's own navigation-time retain (`THREAD_DETAIL_NAVIGATION_RETAIN_MS`).
 */
export const THREAD_NAVIGATION_INTENT_RETAIN_MS = 10_000;
/**
 * Hover dwell before a hover counts as intent. A pointer sweeping across the
 * list must not subscribe to every thread it crosses; a press counts at once.
 */
export const THREAD_NAVIGATION_HOVER_DELAY_MS = 120;
/** Upper bound on concurrent intent retains; the oldest is released first. */
export const MAX_THREAD_NAVIGATION_INTENT_RETAINS = 4;

type Timer = ReturnType<typeof setTimeout>;

export type ReleaseIntentRetain = (options?: { readonly immediately?: boolean }) => void;

export interface ThreadNavigationIntentDeps {
  readonly retain: (ref: ScopedThreadRef) => ReleaseIntentRetain;
  /**
   * The thread's detail is already in the store. Such a thread renders at
   * once, so an intent retain adds nothing; and its subscription may sit in
   * the idle cache, which an intent's immediate release must not drop.
   */
  readonly isDetailLoaded: (ref: ScopedThreadRef) => boolean;
  /**
   * Whether an intent may retain the thread's detail now (hosted: only from a
   * ready session, never on the phone tier). Asked when the dwell ends and
   * when the row is pressed. Defaults to always.
   */
  readonly canRetain?: (ref: ScopedThreadRef) => boolean;
  /** Warms the thread route's component chunk. Idempotent and never throws. */
  readonly preloadThreadRoute: () => void;
  readonly keyOf: (ref: ScopedThreadRef) => string;
  readonly setTimeout?: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimeout?: (timer: Timer) => void;
  readonly retainMs?: number;
  readonly hoverDelayMs?: number;
  readonly maxRetains?: number;
}

export interface ThreadNavigationIntents {
  /** The pointer rests on a row: warm the route now, retain after the dwell. */
  readonly hover: (ref: ScopedThreadRef) => void;
  /** The pointer left a row before its dwell ran out. */
  readonly leave: (ref: ScopedThreadRef) => void;
  /** A press on a row: it is about to navigate. */
  readonly press: (ref: ScopedThreadRef) => void;
  /** Releases every intent retain (tests, teardown). */
  readonly reset: () => void;
}

interface IntentRetain {
  readonly release: ReleaseIntentRetain;
  timer: Timer;
}

/**
 * Navigation intent for thread rows. Sidebar and inbox rows navigate
 * imperatively, so the router's intent preloading never sees them: a row warms
 * the thread route's chunk and starts the thread's detail subscription when
 * the pointer rests on it or presses it, so the history request overlaps the
 * navigation instead of starting from the thread view's mount. `canRetain`
 * gates the subscription, not the route chunk: where it refuses (on hosted Web,
 * a session that is not ready), the route's own retain starts the thread's
 * window once the node is connected.
 *
 * Every retain is released after `THREAD_NAVIGATION_INTENT_RETAIN_MS`, and
 * released immediately. When the intent did navigate, the thread view retained
 * the subscription meanwhile, so the supervisor keeps it: it stays while the
 * view holds it and reaches the idle cache as usual once the view has left,
 * even if the user left the thread before the intent's deadline. When nothing
 * took over (a dwell without a click, a press that only started a scroll or a
 * drag) it is disposed at once instead of idling as a live stream. Intent
 * retains are speculative: a body only they fetched, which no view showed, is
 * the first the store drops when it is over its budget.
 */
export function createThreadNavigationIntents(
  deps: ThreadNavigationIntentDeps,
): ThreadNavigationIntents {
  const schedule = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = deps.clearTimeout ?? ((timer) => clearTimeout(timer));
  const retainMs = deps.retainMs ?? THREAD_NAVIGATION_INTENT_RETAIN_MS;
  const hoverDelayMs = deps.hoverDelayMs ?? THREAD_NAVIGATION_HOVER_DELAY_MS;
  const maxRetains = Math.max(1, deps.maxRetains ?? MAX_THREAD_NAVIGATION_INTENT_RETAINS);

  // Insertion order is age: a renewed intent moves to the end.
  const retains = new Map<string, IntentRetain>();
  // One pointer, so at most one row dwells at a time.
  let pendingHover: { readonly key: string; readonly timer: Timer } | null = null;

  const releaseKey = (key: string) => {
    const entry = retains.get(key);
    if (!entry) return;
    retains.delete(key);
    cancel(entry.timer);
    entry.release({ immediately: true });
  };

  const intend = (ref: ScopedThreadRef) => {
    const key = deps.keyOf(ref);
    const existing = retains.get(key);
    if (existing) {
      cancel(existing.timer);
      retains.delete(key);
      existing.timer = schedule(() => releaseKey(key), retainMs);
      retains.set(key, existing);
      return;
    }
    if (deps.isDetailLoaded(ref)) return;
    const release = deps.retain(ref);
    retains.set(key, { release, timer: schedule(() => releaseKey(key), retainMs) });
    while (retains.size > maxRetains) {
      const oldest = retains.keys().next().value;
      if (oldest === undefined) break;
      releaseKey(oldest);
    }
  };

  const cancelPendingHover = () => {
    if (pendingHover === null) return;
    cancel(pendingHover.timer);
    pendingHover = null;
  };

  return {
    hover: (ref) => {
      deps.preloadThreadRoute();
      const key = deps.keyOf(ref);
      if (pendingHover?.key === key) return;
      cancelPendingHover();
      pendingHover = {
        key,
        timer: schedule(() => {
          pendingHover = null;
          if (deps.canRetain?.(ref) !== false) intend(ref);
        }, hoverDelayMs),
      };
    },
    leave: (ref) => {
      if (pendingHover?.key === deps.keyOf(ref)) cancelPendingHover();
    },
    press: (ref) => {
      deps.preloadThreadRoute();
      cancelPendingHover();
      if (deps.canRetain?.(ref) !== false) intend(ref);
    },
    reset: () => {
      cancelPendingHover();
      // Deleting the visited entry while iterating a Map is well defined.
      for (const key of retains.keys()) releaseKey(key);
    },
  };
}
