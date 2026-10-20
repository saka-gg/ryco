import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";

import { THREAD_DETAIL_NAVIGATION_RETAIN_MS } from "../../lib/threadDetailRetain";

/**
 * How long a navigation intent keeps the thread's detail subscription: the
 * same window as the route's own navigation-time retain.
 */
export const THREAD_NAVIGATION_INTENT_RETAIN_MS = THREAD_DETAIL_NAVIGATION_RETAIN_MS;
/**
 * Hover dwell before a hover counts as intent. A pointer sweeping across the
 * list must not subscribe to every thread it crosses; a press counts at once.
 */
export const THREAD_NAVIGATION_HOVER_DELAY_MS = 120;
/** Upper bound on concurrent intent retains; the oldest is released first. */
export const MAX_THREAD_NAVIGATION_INTENT_RETAINS = 4;
/** At most one environment is connected ahead of a press in this window. */
export const NODE_PRECONNECT_INTERVAL_MS = 5_000;
/** A press connects the same environment ahead of its navigation at most once in this window. */
export const NODE_PRECONNECT_COOLDOWN_MS = 30_000;

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

/**
 * Whether a navigation intent may fetch the thread's window. Outside hosted Web
 * it always may. On hosted Web only from a session that is ready to adopt, so
 * the intent never waits on, or adds to, a connection, which the press
 * pre-connect alone starts; and never on the phone tier.
 */
export function mayPrefetchThreadWindow(input: {
  readonly hosted: boolean;
  readonly phoneTier: boolean;
  readonly sessionReady: boolean;
}): boolean {
  return !input.hosted || (!input.phoneTier && input.sessionReady);
}

/** The parts of a pointer event `isNavigationPress` reads. */
export interface NavigationPressEvent {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: unknown;
  readonly currentTarget: unknown;
  /** A `touch` press may only be the start of a scroll. */
  readonly pointerType?: string;
}

/** Controls inside a row that do their own thing instead of opening the thread. */
const NESTED_CONTROL_SELECTOR =
  "button, a[href], input, textarea, select, [role='button'], [contenteditable='true']";

/**
 * A press that navigates: the primary button, without the modifiers that turn
 * a row click into selection, on the row itself rather than on a control
 * nested in it (a pull request badge, the rename field).
 */
export function isNavigationPress(event: NavigationPressEvent): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = event.target as { readonly closest?: (selector: string) => unknown } | null;
  const control =
    typeof target?.closest === "function" ? target.closest(NESTED_CONTROL_SELECTOR) : null;
  return control === null || control === event.currentTarget;
}

export interface NodePreconnectDeps {
  /** Presses may connect ahead of navigation at all: hosted, and not on the phone tier. */
  readonly enabled: () => boolean;
  /** The environment has no session that is live or on its way. */
  readonly needsConnection: (environmentId: EnvironmentId) => boolean;
  /** Holds short-lived demand for the environment and marks the switch it starts. */
  readonly preconnect: (environmentId: EnvironmentId) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly cooldownMs?: number;
}

export interface NodePreconnect {
  /**
   * Reads a row's pointer press: `isNavigationPress`, and whether the press may
   * connect its environment ahead of the navigation. Rows call it, then
   * {@link NodePreconnect.press} for the row they pressed, in the same handler:
   * the reading lasts until the current task ends.
   */
  readonly notePress: (event: NavigationPressEvent) => boolean;
  /** The row whose press was just read is about to open its thread. */
  readonly press: (ref: ScopedThreadRef) => void;
}

/**
 * Pre-connect on a navigation press: a mouse or pen press on a row of a hosted
 * node without a live session holds that node's demand for a few seconds, so
 * its relay attempt and snapshot overlap the click instead of starting at the
 * route. It is bounded: only navigation presses (never a touch, which may be a
 * scroll), at most one environment per {@link NODE_PRECONNECT_INTERVAL_MS} and
 * each environment at most once per {@link NODE_PRECONNECT_COOLDOWN_MS}. The
 * demand is preemptible, so it never displaces a mounted view; the planner
 * makes room only by releasing the least recently used environment that
 * nothing demands.
 */
export function createNodePreconnect(deps: NodePreconnectDeps): NodePreconnect {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? NODE_PRECONNECT_INTERVAL_MS;
  const cooldownMs = deps.cooldownMs ?? NODE_PRECONNECT_COOLDOWN_MS;
  let armed = false;
  let pressSequence = 0;
  let lastPreconnectAt: number | null = null;
  const lastPreconnectByEnvironment = new Map<EnvironmentId, number>();

  return {
    notePress: (event) => {
      const navigates = isNavigationPress(event);
      armed = navigates && event.pointerType !== "touch";
      if (armed) {
        const press = ++pressSequence;
        queueMicrotask(() => {
          if (pressSequence === press) armed = false;
        });
      }
      return navigates;
    },
    press: (ref) => {
      if (!armed) return;
      armed = false;
      if (!deps.enabled()) return;
      const at = now();
      if (lastPreconnectAt !== null && at - lastPreconnectAt < intervalMs) return;
      const previous = lastPreconnectByEnvironment.get(ref.environmentId);
      if (previous !== undefined && at - previous < cooldownMs) return;
      if (!deps.needsConnection(ref.environmentId)) return;
      lastPreconnectAt = at;
      lastPreconnectByEnvironment.set(ref.environmentId, at);
      for (const [environmentId, startedAt] of lastPreconnectByEnvironment) {
        if (at - startedAt >= cooldownMs) lastPreconnectByEnvironment.delete(environmentId);
      }
      deps.preconnect(ref.environmentId);
    },
  };
}
