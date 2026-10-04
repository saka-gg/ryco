/**
 * Defer a desktop relaunch until the local backend's agent turns are done.
 *
 * Applying a Hub, network, or Tailscale change relaunches Desktop, which stops
 * the backend and every provider turn it owns. When the operator chooses to
 * wait, the change is saved at once and only the relaunch waits. A saved change
 * therefore survives Ryco quitting, crashing, reloading, or updating before the
 * turns finish: it applies on the next launch, whichever comes first. One
 * pending relaunch carries every change saved while it waits.
 */

/** When the change's relaunch happens. */
export type DesktopRelaunchTiming = "now" | "deferred";

/**
 * Save a launch change. With `now` it also relaunches Desktop to apply it,
 * unless the running backend already serves the change, which it reports as
 * `"applied"`; with `deferred` it only saves it, and the scheduler relaunches
 * later.
 */
export type DesktopRelaunchChange = (timing: DesktopRelaunchTiming) => Promise<void | "applied">;

export interface DesktopRelaunchScheduler {
  /**
   * Apply `change` and relaunch now. Without one, relaunch for the changes
   * already saved. Resolves whether Desktop is relaunching: a change the
   * running backend already serves, with nothing else saved, needs none.
   */
  readonly relaunchNow: (change?: DesktopRelaunchChange) => Promise<boolean>;
  /**
   * Save `change` now and relaunch once no interruptible local turn remains.
   * Rejects, without arming anything, when the change could not be saved.
   */
  readonly scheduleAfterActiveTurns: (change: DesktopRelaunchChange) => Promise<void>;
  /** Stop waiting. Saved changes still apply on the next launch. */
  readonly cancel: () => void;
  readonly pending: () => boolean;
}

export function createDesktopRelaunchScheduler(input: {
  /** Interruptible local turns, or `null` while that cannot be known yet. */
  readonly readActiveTurns: () => number | null;
  /** Subscribe to the state `readActiveTurns` reads. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Show (or with `null`, remove) the waiting notice. */
  readonly present: (waiting: { readonly activeTurns: number | null } | null) => void;
  /** Relaunch Desktop without changing anything. */
  readonly restart: () => Promise<void>;
  /** A deferred relaunch failed after the operator walked away. */
  readonly onError: (error: unknown) => void;
}): DesktopRelaunchScheduler {
  let armed = false;
  let unsubscribe: (() => void) | null = null;
  let running = false;
  // The store changes on every streamed token; the notice only on a new count.
  let presented: { readonly activeTurns: number | null } | null = null;

  const stopWatching = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (presented !== null) {
      presented = null;
      input.present(null);
    }
  };

  const relaunchNow = async (change?: DesktopRelaunchChange): Promise<boolean> => {
    const carriesSaved = armed;
    armed = false;
    stopWatching();
    running = true;
    try {
      const result = change === undefined ? undefined : await change("now");
      // A change that turns out to need no relaunch must not strand the ones
      // saved earlier; Desktop collapses a second relaunch request into one.
      if (change === undefined || carriesSaved) {
        await input.restart();
        return true;
      }
      return result !== "applied";
    } finally {
      running = false;
    }
  };

  const check = () => {
    if (!armed || running) return;
    const activeTurns = input.readActiveTurns();
    if (activeTurns === null || activeTurns > 0) {
      if (presented === null || presented.activeTurns !== activeTurns) {
        presented = { activeTurns };
        input.present(presented);
      }
      return;
    }
    void relaunchNow().catch(input.onError);
  };

  return {
    relaunchNow,
    scheduleAfterActiveTurns: async (change) => {
      await change("deferred");
      armed = true;
      unsubscribe ??= input.subscribe(check);
      check();
    },
    cancel: () => {
      armed = false;
      stopWatching();
    },
    pending: () => armed,
  };
}
