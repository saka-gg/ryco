/**
 * Defer desktop relaunches until the local backend's agent turns are done.
 *
 * Applying a Hub, network, or Tailscale change relaunches Desktop, which stops
 * the backend and every provider turn it owns. Each relaunch is the IPC call
 * that persists its change and restarts, so a deferred change is not persisted
 * until it runs. Deferred relaunches therefore queue rather than replace each
 * other and run in order, so no requested change is dropped.
 */

export type DesktopRelaunch = () => Promise<void>;

export interface DesktopRelaunchScheduler {
  /** Run every deferred relaunch, then this one, now. */
  readonly relaunchNow: (relaunch?: DesktopRelaunch) => Promise<void>;
  /** Defer a relaunch until no interruptible local turn remains. */
  readonly scheduleAfterActiveTurns: (relaunch: DesktopRelaunch) => void;
  /** Drop every deferred relaunch; nothing they would have changed is persisted. */
  readonly cancel: () => void;
  readonly pendingCount: () => number;
}

export function createDesktopRelaunchScheduler(input: {
  readonly readActiveTurns: () => number;
  /** Subscribe to the state `readActiveTurns` reads. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Show (or with `null`, remove) the waiting notice. */
  readonly present: (waiting: { readonly activeTurns: number } | null) => void;
  /** A deferred relaunch failed after the operator walked away. */
  readonly onError: (error: unknown) => void;
}): DesktopRelaunchScheduler {
  let queue: DesktopRelaunch[] = [];
  let unsubscribe: (() => void) | null = null;
  let running = false;
  // The store changes on every streamed token; the notice only on a new count.
  let presented: number | null = null;

  const stopWatching = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (presented !== null) input.present(null);
    presented = null;
  };

  const relaunchNow = async (relaunch?: DesktopRelaunch): Promise<void> => {
    const runs = [...queue, ...(relaunch === undefined ? [] : [relaunch])];
    queue = [];
    stopWatching();
    running = true;
    try {
      for (const run of runs) await run();
    } finally {
      running = false;
    }
  };

  const check = () => {
    if (queue.length === 0 || running) return;
    const activeTurns = input.readActiveTurns();
    if (activeTurns > 0) {
      if (presented !== activeTurns) input.present({ activeTurns });
      presented = activeTurns;
      return;
    }
    void relaunchNow().catch(input.onError);
  };

  return {
    relaunchNow,
    scheduleAfterActiveTurns: (relaunch) => {
      queue.push(relaunch);
      unsubscribe ??= input.subscribe(check);
      check();
    },
    cancel: () => {
      queue = [];
      stopWatching();
    },
    pendingCount: () => queue.length,
  };
}
