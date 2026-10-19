/**
 * Window and power lifecycle, reduced to what the desktop workspace client needs
 * from it: whether the app counts as backgrounded (non-retained machine
 * connections may then be released) and when to look at which machines are
 * online again.
 *
 * Losing focus is deliberately not a signal. Switching to another app or window
 * keeps every warm connection, so coming back costs nothing. Only the window
 * leaving sight (minimized or hidden) or the screen locking counts, and then only
 * after a grace period; going to sleep counts at once because sockets rarely
 * survive it. Any sign of use (restore, show, focus, unlock, resume) is
 * foreground again, which also keeps a missed event from leaving the app stuck
 * in the background.
 */

export type DesktopActivityEvent =
  | "minimize"
  | "hide"
  | "lock"
  | "suspend"
  | "restore"
  | "show"
  | "focus"
  | "unlock"
  | "resume";

export interface DesktopActivityTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

/** Timers that never keep the main process alive on their own. */
const systemTimers: DesktopActivityTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** How long the window stays out of sight (or the screen locked) before the app is backgrounded. */
export const DESKTOP_BACKGROUND_GRACE_MS = 3 * 60_000;
/** How often the machine catalog is refreshed while a window is in sight. */
export const DESKTOP_PRESENCE_REFRESH_INTERVAL_MS = 90_000;
/** Focus refreshes the machine catalog at most this often. */
export const DESKTOP_PRESENCE_FOCUS_THROTTLE_MS = 30_000;

export interface DesktopActivityHandler {
  readonly handle: (event: DesktopActivityEvent) => void;
  readonly dispose: () => void;
}

export function createDesktopBackgroundSignal(input: {
  readonly setBackgrounded: (backgrounded: boolean) => void;
  readonly graceMs?: number;
  readonly timers?: DesktopActivityTimers;
}): DesktopActivityHandler {
  const timers = input.timers ?? systemTimers;
  const graceMs = input.graceMs ?? DESKTOP_BACKGROUND_GRACE_MS;
  let backgrounded = false;
  let pending: unknown = null;

  const cancelPending = () => {
    if (pending === null) return;
    timers.clearTimeout(pending);
    pending = null;
  };
  const apply = (next: boolean) => {
    if (backgrounded === next) return;
    backgrounded = next;
    input.setBackgrounded(next);
  };

  return {
    handle: (event) => {
      switch (event) {
        case "minimize":
        case "hide":
        case "lock":
          // A second leaving event must not push the deadline back.
          if (backgrounded || pending !== null) return;
          pending = timers.setTimeout(() => {
            pending = null;
            apply(true);
          }, graceMs);
          return;
        case "suspend":
          cancelPending();
          apply(true);
          return;
        case "restore":
        case "show":
        case "focus":
        case "unlock":
        case "resume":
          cancelPending();
          apply(false);
          return;
      }
    },
    dispose: cancelPending,
  };
}

export function createDesktopPresenceRefresh(input: {
  readonly refresh: () => void;
  readonly now?: () => number;
  readonly timers?: DesktopActivityTimers;
}): DesktopActivityHandler {
  const timers = input.timers ?? systemTimers;
  const now = input.now ?? Date.now;
  let lastRefreshAt: number | null = null;
  let polling: unknown = null;

  const refresh = () => {
    lastRefreshAt = now();
    input.refresh();
  };
  const startPolling = () => {
    if (polling !== null) return;
    polling = timers.setInterval(refresh, DESKTOP_PRESENCE_REFRESH_INTERVAL_MS);
  };
  const stopPolling = () => {
    if (polling === null) return;
    timers.clearInterval(polling);
    polling = null;
  };

  return {
    handle: (event) => {
      switch (event) {
        case "focus":
          startPolling();
          if (
            lastRefreshAt === null ||
            now() - lastRefreshAt >= DESKTOP_PRESENCE_FOCUS_THROTTLE_MS
          ) {
            refresh();
          }
          return;
        case "resume":
        case "unlock":
          // The gap since the last look is unknown, so these are never throttled.
          startPolling();
          refresh();
          return;
        case "show":
        case "restore":
          startPolling();
          return;
        case "minimize":
        case "hide":
        case "lock":
        case "suspend":
          stopPolling();
          return;
      }
    },
    dispose: stopPolling,
  };
}

/** The subset of Electron's `BrowserWindow` this wiring needs. */
export interface DesktopActivityWindow {
  on(
    event: "minimize" | "restore" | "hide" | "show" | "focus" | "closed",
    listener: () => void,
  ): unknown;
}

type DesktopActivityPowerEvent = "lock-screen" | "unlock-screen" | "suspend" | "resume";

/** The subset of Electron's `powerMonitor` this wiring needs. */
export interface DesktopActivityPower {
  on(event: DesktopActivityPowerEvent, listener: () => void): unknown;
  removeListener(event: DesktopActivityPowerEvent, listener: () => void): unknown;
}

export interface DesktopWorkspaceActivity {
  /** Feed one window's lifecycle in. Its listeners end with the window. */
  readonly attachWindow: (window: DesktopActivityWindow) => void;
  readonly attachPower: (power: DesktopActivityPower) => void;
  readonly dispose: () => void;
}

export function createDesktopWorkspaceActivity(input: {
  readonly setBackgrounded: (backgrounded: boolean) => void;
  /** Fire and forget: the caller owns error handling. */
  readonly refreshCatalog: () => void;
  /** Whether any window is currently visible and not minimized. */
  readonly isWindowInSight: () => boolean;
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly timers?: DesktopActivityTimers;
}): DesktopWorkspaceActivity {
  const handlers = [
    createDesktopBackgroundSignal({
      setBackgrounded: input.setBackgrounded,
      ...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
      ...(input.timers === undefined ? {} : { timers: input.timers }),
    }),
    createDesktopPresenceRefresh({
      refresh: input.refreshCatalog,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.timers === undefined ? {} : { timers: input.timers }),
    }),
  ];
  const dispatch = (event: DesktopActivityEvent) => {
    for (const handler of handlers) handler.handle(event);
  };
  const dispatchReturn = (event: "resume" | "unlock") => {
    dispatch(event);
    // Waking or unlocking does not bring a minimized or hidden window back, so
    // its grace period starts over.
    if (!input.isWindowInSight()) dispatch("minimize");
  };

  const powerBindings: ReadonlyArray<readonly [DesktopActivityPowerEvent, () => void]> = [
    ["lock-screen", () => dispatch("lock")],
    ["unlock-screen", () => dispatchReturn("unlock")],
    ["suspend", () => dispatch("suspend")],
    ["resume", () => dispatchReturn("resume")],
  ];
  let attachedPower: DesktopActivityPower | null = null;

  return {
    attachWindow: (window) => {
      window.on("minimize", () => dispatch("minimize"));
      window.on("restore", () => dispatch("restore"));
      window.on("hide", () => dispatch("hide"));
      window.on("show", () => dispatch("show"));
      window.on("focus", () => dispatch("focus"));
      // A closed window is out of sight for good; a new one announces itself with `show`.
      window.on("closed", () => dispatch("hide"));
    },
    attachPower: (power) => {
      if (attachedPower !== null) return;
      attachedPower = power;
      for (const [event, listener] of powerBindings) power.on(event, listener);
    },
    dispose: () => {
      for (const handler of handlers) handler.dispose();
      if (attachedPower === null) return;
      for (const [event, listener] of powerBindings) attachedPower.removeListener(event, listener);
      attachedPower = null;
    },
  };
}
