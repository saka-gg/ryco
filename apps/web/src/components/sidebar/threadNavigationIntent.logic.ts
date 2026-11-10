import type { EnvironmentId, ScopedThreadRef } from "@ryco/contracts";

export {
  createThreadNavigationIntents,
  MAX_THREAD_NAVIGATION_INTENT_RETAINS,
  THREAD_NAVIGATION_HOVER_DELAY_MS,
  THREAD_NAVIGATION_INTENT_RETAIN_MS,
  type ReleaseIntentRetain,
  type ThreadNavigationIntentDeps,
  type ThreadNavigationIntents,
} from "@ryco/client-runtime/connection";

/** At most one environment is connected ahead of a press in this window. */
export const NODE_PRECONNECT_INTERVAL_MS = 5_000;
/** A press connects the same environment ahead of its navigation at most once in this window. */
export const NODE_PRECONNECT_COOLDOWN_MS = 30_000;

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
