import {
  createThreadNavigationIntents,
  type ReleaseIntentRetain,
} from "@ryco/client-runtime/connection/threadNavigationIntent";
import type { ScopedThreadRef } from "@ryco/contracts";

// Home's thread prefetch: a press on a row starts the thread's detail
// subscription before the navigation does (web's navigation intent, shared),
// and once Home has been still for a moment the first few rows are fetched
// too, so opening a recent thread shows its whole conversation at once. Every
// retain here is speculative: it never displaces a thread a screen holds, a
// body only it fetched is the first the store drops, and it is only taken for
// a machine that is already live (it creates no connection demand).

/** How many rows from the top Home keeps warm. */
export const HOME_PREFETCH_TOP_ROWS = 5;
/** How long Home stays still before it warms its top rows. */
export const HOME_PREFETCH_IDLE_MS = 600;
/**
 * How long the warm set outlives Home losing focus. The thread a row opened takes its own
 * retain meanwhile, so its subscription carries on instead of starting over.
 */
export const HOME_PREFETCH_BLUR_RELEASE_MS = 1_500;

type Timer = ReturnType<typeof setTimeout>;

export interface HomeThreadPrefetchDeps {
  readonly retain: (ref: ScopedThreadRef) => ReleaseIntentRetain;
  /** The body is in the store already: the thread opens at once without a prefetch. */
  readonly isDetailLoaded: (ref: ScopedThreadRef) => boolean;
  /** The thread's machine is live now (connected, with its own shell snapshot). */
  readonly canRetain: (ref: ScopedThreadRef) => boolean;
  readonly keyOf: (ref: ScopedThreadRef) => string;
  readonly setTimeout?: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimeout?: (timer: Timer) => void;
  readonly topRows?: number;
  readonly idleMs?: number;
  readonly blurReleaseMs?: number;
}

export interface HomeThreadPrefetch {
  /** A finger went down on a row: it may be about to open it. */
  readonly pressIn: (ref: ScopedThreadRef) => void;
  /**
   * Home shows these rows, top first, and is focused and in the foreground: they are warmed
   * once nothing changed for `HOME_PREFETCH_IDLE_MS`. Call again whenever the rows or a
   * machine's readiness (`readiness`, any value that changes with it) change; rows that left
   * the top are let go.
   */
  readonly show: (refs: ReadonlyArray<ScopedThreadRef>, readiness?: string) => void;
  /** Home lost focus: the warm set goes after `HOME_PREFETCH_BLUR_RELEASE_MS`. */
  readonly blur: () => void;
  /** The app went to the background: everything goes now. */
  readonly background: () => void;
  readonly dispose: () => void;
}

export function createHomeThreadPrefetch(deps: HomeThreadPrefetchDeps): HomeThreadPrefetch {
  const schedule = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = deps.clearTimeout ?? ((timer) => clearTimeout(timer));
  const topRows = Math.max(0, deps.topRows ?? HOME_PREFETCH_TOP_ROWS);
  const idleMs = deps.idleMs ?? HOME_PREFETCH_IDLE_MS;
  const blurReleaseMs = deps.blurReleaseMs ?? HOME_PREFETCH_BLUR_RELEASE_MS;

  const intents = createThreadNavigationIntents({
    retain: deps.retain,
    isDetailLoaded: deps.isDetailLoaded,
    canRetain: deps.canRetain,
    keyOf: deps.keyOf,
    // The phone has no route chunks to warm.
    preloadThreadRoute: () => {},
    ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
    ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
  });

  const warm = new Map<string, ReleaseIntentRetain>();
  let idleTimer: Timer | null = null;
  let blurTimer: Timer | null = null;

  const clearIdle = () => {
    if (idleTimer !== null) cancel(idleTimer);
    idleTimer = null;
  };
  const clearBlur = () => {
    if (blurTimer !== null) cancel(blurTimer);
    blurTimer = null;
  };
  const releaseWarm = (keep: ReadonlySet<string>) => {
    for (const [key, release] of warm) {
      if (keep.has(key)) continue;
      warm.delete(key);
      release({ immediately: true });
    }
  };
  const warmUp = (refs: ReadonlyArray<ScopedThreadRef>) => {
    const wanted = new Map<string, ScopedThreadRef>();
    for (const ref of refs) {
      if (wanted.size >= topRows) break;
      wanted.set(deps.keyOf(ref), ref);
    }
    releaseWarm(new Set(wanted.keys()));
    for (const [key, ref] of wanted) {
      if (warm.has(key)) continue;
      if (deps.isDetailLoaded(ref) || !deps.canRetain(ref)) continue;
      warm.set(key, deps.retain(ref));
    }
  };

  return {
    pressIn: (ref) => intents.press(ref),
    show: (refs) => {
      clearBlur();
      clearIdle();
      idleTimer = schedule(() => {
        idleTimer = null;
        warmUp(refs);
      }, idleMs);
    },
    blur: () => {
      clearIdle();
      if (blurTimer !== null || warm.size === 0) return;
      blurTimer = schedule(() => {
        blurTimer = null;
        releaseWarm(new Set());
      }, blurReleaseMs);
    },
    background: () => {
      clearIdle();
      clearBlur();
      releaseWarm(new Set());
      intents.reset();
    },
    dispose: () => {
      clearIdle();
      clearBlur();
      releaseWarm(new Set());
      intents.reset();
    },
  };
}
