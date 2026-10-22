import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopBackgroundSignal,
  createDesktopPresenceRefresh,
  createDesktopWorkspaceActivity,
  DESKTOP_BACKGROUND_GRACE_MS,
  DESKTOP_PRESENCE_FOCUS_THROTTLE_MS,
  DESKTOP_PRESENCE_REFRESH_INTERVAL_MS,
  type DesktopActivityEvent,
  type DesktopActivityTimers,
} from "./desktopBackgroundSignal.ts";

const MINUTE_MS = 60_000;

/** Deterministic timers: nothing runs until `advance` moves the clock. */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { due: number; repeatMs: number | null; run: () => void }>();
  const timers: DesktopActivityTimers = {
    setTimeout: (run, ms) => {
      const id = nextId++;
      tasks.set(id, { due: now + ms, repeatMs: null, run });
      return id;
    },
    clearTimeout: (id) => void tasks.delete(id as number),
    setInterval: (run, ms) => {
      const id = nextId++;
      tasks.set(id, { due: now + ms, repeatMs: ms, run });
      return id;
    },
    clearInterval: (id) => void tasks.delete(id as number),
  };
  return {
    timers,
    now: () => now,
    pendingTimers: () => tasks.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...tasks.entries()]
          .filter(([, task]) => task.due <= target)
          .toSorted(([, a], [, b]) => a.due - b.due)[0];
        if (!next) break;
        const [id, task] = next;
        now = task.due;
        if (task.repeatMs === null) tasks.delete(id);
        else task.due += task.repeatMs;
        task.run();
      }
      now = target;
    },
  };
}

function feed(handler: { handle: (event: DesktopActivityEvent) => void }, ...events: string[]) {
  for (const event of events) handler.handle(event as DesktopActivityEvent);
}

describe("desktop background signal", () => {
  function makeSignal() {
    const clock = makeClock();
    const setBackgrounded = vi.fn();
    const signal = createDesktopBackgroundSignal({ setBackgrounded, timers: clock.timers });
    return { clock, setBackgrounded, signal };
  }

  it.each(["minimize", "hide", "lock"] as const)(
    "backgrounds only after the grace period following %s",
    (event) => {
      const { clock, setBackgrounded, signal } = makeSignal();
      signal.handle(event);

      clock.advance(DESKTOP_BACKGROUND_GRACE_MS - 1);
      expect(setBackgrounded).not.toHaveBeenCalled();
      clock.advance(1);
      expect(setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("uses a three minute grace period", () => {
    expect(DESKTOP_BACKGROUND_GRACE_MS).toBe(3 * MINUTE_MS);
  });

  it.each(["restore", "show", "focus", "unlock", "resume"] as const)(
    "does nothing when %s arrives within the grace period",
    (event) => {
      const { clock, setBackgrounded, signal } = makeSignal();
      signal.handle("minimize");
      clock.advance(MINUTE_MS);
      signal.handle(event);

      clock.advance(10 * MINUTE_MS);
      expect(setBackgrounded).not.toHaveBeenCalled();
      expect(clock.pendingTimers()).toBe(0);
    },
  );

  it("does nothing for returns that were never preceded by leaving", () => {
    const { clock, setBackgrounded, signal } = makeSignal();
    feed(signal, "focus", "show", "restore", "unlock", "resume");
    clock.advance(10 * MINUTE_MS);
    expect(setBackgrounded).not.toHaveBeenCalled();
  });

  it("backgrounds at once on suspend and drops a pending grace period", () => {
    const { clock, setBackgrounded, signal } = makeSignal();
    signal.handle("minimize");
    clock.advance(MINUTE_MS);
    signal.handle("suspend");

    expect(setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(10 * MINUTE_MS);
    expect(setBackgrounded).toHaveBeenCalledOnce();
  });

  it("returns to the foreground on resume and on any sign of use", () => {
    for (const event of ["resume", "focus", "unlock", "show", "restore"] as const) {
      const { setBackgrounded, signal } = makeSignal();
      signal.handle("suspend");
      signal.handle(event);
      expect(setBackgrounded.mock.calls).toEqual([[true], [false]]);
    }
  });

  it("backgrounds once for repeated leaving events and does not push the deadline back", () => {
    const { clock, setBackgrounded, signal } = makeSignal();
    signal.handle("minimize");
    clock.advance(2 * MINUTE_MS);
    feed(signal, "hide", "lock", "minimize");
    clock.advance(MINUTE_MS);
    expect(setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);

    feed(signal, "hide", "lock");
    clock.advance(10 * MINUTE_MS);
    expect(setBackgrounded).toHaveBeenCalledOnce();
  });

  it("starts a fresh grace period after returning", () => {
    const { clock, setBackgrounded, signal } = makeSignal();
    signal.handle("minimize");
    clock.advance(2 * MINUTE_MS);
    signal.handle("restore");
    signal.handle("minimize");

    clock.advance(2 * MINUTE_MS);
    expect(setBackgrounded).not.toHaveBeenCalled();
    clock.advance(MINUTE_MS);
    expect(setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("drops a pending grace period on dispose", () => {
    const { clock, setBackgrounded, signal } = makeSignal();
    signal.handle("lock");
    signal.dispose();
    clock.advance(10 * MINUTE_MS);
    expect(setBackgrounded).not.toHaveBeenCalled();
  });
});

describe("desktop presence refresh", () => {
  function makePresence() {
    const clock = makeClock();
    const refresh = vi.fn();
    const presence = createDesktopPresenceRefresh({
      refresh,
      now: clock.now,
      timers: clock.timers,
    });
    return { clock, refresh, presence };
  }

  it("refreshes on focus at most once per throttle window", () => {
    const { clock, refresh, presence } = makePresence();
    presence.handle("focus");
    clock.advance(DESKTOP_PRESENCE_FOCUS_THROTTLE_MS - 1);
    presence.handle("focus");
    expect(refresh).toHaveBeenCalledOnce();

    clock.advance(1);
    presence.handle("focus");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes on resume and unlock whatever the throttle says", () => {
    const { refresh, presence } = makePresence();
    feed(presence, "focus", "resume", "unlock");
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not refresh just because a window was shown or restored", () => {
    const { refresh, presence } = makePresence();
    feed(presence, "show", "restore", "minimize", "hide", "lock", "suspend");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes every 90 seconds while a window is in sight", () => {
    const { clock, refresh, presence } = makePresence();
    presence.handle("show");
    clock.advance(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    clock.advance(1);
    expect(refresh).toHaveBeenCalledOnce();
    clock.advance(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS).toBe(90_000);
  });

  it.each(["minimize", "hide", "lock", "suspend"] as const)(
    "stops the interval on %s and resumes it with the next sign of use",
    (event) => {
      const { clock, refresh, presence } = makePresence();
      presence.handle("show");
      presence.handle(event);
      expect(clock.pendingTimers()).toBe(0);
      clock.advance(10 * MINUTE_MS);
      expect(refresh).not.toHaveBeenCalled();

      presence.handle("restore");
      clock.advance(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it("keeps one interval however often the window is shown, and lets a refresh count for focus", () => {
    const { clock, refresh, presence } = makePresence();
    feed(presence, "show", "focus", "restore", "show");
    expect(clock.pendingTimers()).toBe(1);
    expect(refresh).toHaveBeenCalledOnce();

    clock.advance(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    presence.handle("focus");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops the interval on dispose", () => {
    const { clock, presence } = makePresence();
    presence.handle("show");
    presence.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });
});

/** Stands in for `BrowserWindow`: only the lifecycle events the wiring listens to. */
class FakeWindow extends EventEmitter {}

/** Stands in for `powerMonitor`. */
class FakePower extends EventEmitter {}

describe("desktop workspace activity wiring", () => {
  function makeActivity() {
    const clock = makeClock();
    const state = { windowInSight: true };
    const setBackgrounded = vi.fn();
    const refreshCatalog = vi.fn();
    const activity = createDesktopWorkspaceActivity({
      setBackgrounded,
      refreshCatalog,
      isWindowInSight: () => state.windowInSight,
      now: clock.now,
      timers: clock.timers,
    });
    const window = new FakeWindow();
    const power = new FakePower();
    activity.attachWindow(window);
    activity.attachPower(power);
    return { clock, state, setBackgrounded, refreshCatalog, activity, window, power };
  }

  it("keeps warm connections when the app only loses focus", () => {
    const f = makeActivity();
    f.window.emit("focus");
    f.window.emit("blur");
    f.clock.advance(30 * MINUTE_MS);
    f.window.emit("blur");
    f.window.emit("focus");
    f.window.emit("blur");
    f.clock.advance(30 * MINUTE_MS);

    expect(f.setBackgrounded).not.toHaveBeenCalled();
  });

  it("backgrounds a minimized window after the grace period and restores it on return", () => {
    const f = makeActivity();
    f.window.emit("minimize");
    f.clock.advance(DESKTOP_BACKGROUND_GRACE_MS);
    expect(f.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);

    f.window.emit("restore");
    expect(f.setBackgrounded.mock.calls).toEqual([[true], [false]]);
  });

  it("treats a hidden or closed window as out of sight", () => {
    for (const event of ["hide", "closed"]) {
      const f = makeActivity();
      f.window.emit(event);
      f.clock.advance(DESKTOP_BACKGROUND_GRACE_MS);
      expect(f.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);
      f.window.emit("show");
      expect(f.setBackgrounded).toHaveBeenLastCalledWith(false);
    }
  });

  it("backgrounds a locked screen after the grace period and refreshes on unlock", () => {
    const f = makeActivity();
    f.power.emit("lock-screen");
    f.clock.advance(DESKTOP_BACKGROUND_GRACE_MS - 1);
    expect(f.setBackgrounded).not.toHaveBeenCalled();
    f.clock.advance(1);
    expect(f.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);

    f.power.emit("unlock-screen");
    expect(f.setBackgrounded).toHaveBeenLastCalledWith(false);
    expect(f.refreshCatalog).toHaveBeenCalledOnce();
  });

  it("backgrounds at once on suspend and refreshes presence on resume", () => {
    const f = makeActivity();
    f.power.emit("suspend");
    expect(f.setBackgrounded).toHaveBeenCalledExactlyOnceWith(true);

    f.power.emit("resume");
    expect(f.setBackgrounded.mock.calls).toEqual([[true], [false]]);
    expect(f.refreshCatalog).toHaveBeenCalledOnce();
  });

  it("starts the grace period over when waking with the window still out of sight", () => {
    const f = makeActivity();
    f.window.emit("minimize");
    f.power.emit("suspend");
    f.state.windowInSight = false;
    f.power.emit("resume");
    expect(f.setBackgrounded.mock.calls).toEqual([[true], [false]]);

    f.clock.advance(DESKTOP_BACKGROUND_GRACE_MS);
    expect(f.setBackgrounded.mock.calls).toEqual([[true], [false], [true]]);
    f.window.emit("restore");
    expect(f.setBackgrounded).toHaveBeenLastCalledWith(false);
  });

  it("does not start a grace period when waking with a window in sight", () => {
    const f = makeActivity();
    f.power.emit("suspend");
    f.power.emit("resume");
    f.clock.advance(10 * MINUTE_MS);
    expect(f.setBackgrounded.mock.calls).toEqual([[true], [false]]);
  });

  it("refreshes presence on focus, throttled, and every 90 seconds while in sight", () => {
    const f = makeActivity();
    f.window.emit("show");
    f.window.emit("focus");
    expect(f.refreshCatalog).toHaveBeenCalledOnce();
    f.window.emit("blur");
    f.window.emit("focus");
    expect(f.refreshCatalog).toHaveBeenCalledOnce();

    f.clock.advance(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS);
    expect(f.refreshCatalog).toHaveBeenCalledTimes(2);

    f.window.emit("minimize");
    f.clock.advance(10 * MINUTE_MS);
    expect(f.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not poll presence while the screen is locked or the machine sleeps", () => {
    const f = makeActivity();
    f.window.emit("show");
    f.power.emit("lock-screen");
    f.clock.advance(10 * MINUTE_MS);
    expect(f.refreshCatalog).not.toHaveBeenCalled();

    f.power.emit("unlock-screen");
    expect(f.refreshCatalog).toHaveBeenCalledOnce();
    f.clock.advance(DESKTOP_PRESENCE_REFRESH_INTERVAL_MS);
    expect(f.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it("adds listeners without touching ones registered elsewhere, and removes only its own", () => {
    const f = makeActivity();
    const foreign = vi.fn();
    f.power.on("resume", foreign);
    f.power.on("unlock-screen", foreign);

    f.power.emit("resume");
    f.power.emit("unlock-screen");
    expect(foreign).toHaveBeenCalledTimes(2);

    f.activity.dispose();
    expect(f.power.listenerCount("resume")).toBe(1);
    expect(f.power.listenerCount("unlock-screen")).toBe(1);
    expect(f.power.listenerCount("lock-screen")).toBe(0);
    expect(f.power.listenerCount("suspend")).toBe(0);
  });

  it("binds the power monitor once and cancels timers on dispose", () => {
    const f = makeActivity();
    f.activity.attachPower(f.power);
    expect(f.power.listenerCount("suspend")).toBe(1);

    f.window.emit("show");
    f.window.emit("minimize");
    f.activity.dispose();
    f.clock.advance(10 * MINUTE_MS);
    expect(f.setBackgrounded).not.toHaveBeenCalled();
    expect(f.clock.pendingTimers()).toBe(0);
  });
});
