import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_KEEP_AWAKE_RECHECK_MS,
  DesktopKeepAwakeController,
  isDesktopNodeReachable,
  shouldKeepDesktopAwake,
} from "./desktopKeepAwake.ts";

function makeHarness(initial: { enabled: boolean; reachable: boolean; onBattery: boolean }) {
  const inputs = { ...initial };
  const active = new Set<number>();
  const calls: string[] = [];
  let nextId = 1;
  const listeners = new Map<string, Set<() => void>>();
  const intervals: Array<{
    callback: () => void;
    ms: number;
    cleared: boolean;
    unref: () => void;
  }> = [];
  const controller = new DesktopKeepAwakeController({
    blocker: {
      start: (type) => {
        calls.push(`start:${type}`);
        const id = nextId++;
        active.add(id);
        return id;
      },
      stop: (id) => {
        calls.push(`stop:${id}`);
        active.delete(id);
      },
      isStarted: (id) => active.has(id),
    },
    power: {
      isOnBatteryPower: () => inputs.onBattery,
      on: (event, listener) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      removeListener: (event, listener) => {
        listeners.get(event)?.delete(listener);
      },
    },
    read: () => ({ enabled: inputs.enabled, reachable: inputs.reachable }),
    setInterval: (callback, ms) => {
      const handle = { callback, ms, cleared: false, unref: () => undefined };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  return { controller, inputs, active, calls, listeners, intervals, emit };
}

describe("shouldKeepDesktopAwake", () => {
  it("holds only a reachable node, on AC power, with the preference on", () => {
    expect(shouldKeepDesktopAwake({ enabled: true, reachable: true, onBattery: false })).toBe(true);
    expect(shouldKeepDesktopAwake({ enabled: false, reachable: true, onBattery: false })).toBe(
      false,
    );
    expect(shouldKeepDesktopAwake({ enabled: true, reachable: false, onBattery: false })).toBe(
      false,
    );
    expect(shouldKeepDesktopAwake({ enabled: true, reachable: true, onBattery: true })).toBe(false);
  });
});

describe("isDesktopNodeReachable", () => {
  it("counts the Hub connector, effective network exposure, and Tailscale Serve", () => {
    const base = {
      hubReachable: false,
      effectiveServerExposureMode: "local-only" as const,
      tailscaleServeEnabled: false,
    };
    expect(isDesktopNodeReachable(base)).toBe(false);
    expect(isDesktopNodeReachable({ ...base, hubReachable: true })).toBe(true);
    expect(
      isDesktopNodeReachable({ ...base, effectiveServerExposureMode: "network-accessible" }),
    ).toBe(true);
    expect(isDesktopNodeReachable({ ...base, tailscaleServeEnabled: true })).toBe(true);
  });
});

describe("DesktopKeepAwakeController", () => {
  it("holds a reachable desktop awake on AC and releases it on battery", () => {
    // Before this, a desktop-hosted node had no sleep prevention at all.
    const harness = makeHarness({ enabled: true, reachable: true, onBattery: false });
    harness.controller.start();
    expect(harness.calls).toEqual(["start:prevent-app-suspension"]);
    expect(harness.controller.state()).toEqual({
      enabled: true,
      reachable: true,
      onBattery: false,
      active: true,
    });

    harness.inputs.onBattery = true;
    harness.emit("on-battery");
    expect(harness.active.size).toBe(0);
    expect(harness.controller.state().active).toBe(false);

    harness.inputs.onBattery = false;
    harness.emit("on-ac");
    expect(harness.active.size).toBe(1);
  });

  it("applies the preference live and never holds an unreachable node", () => {
    const harness = makeHarness({ enabled: true, reachable: false, onBattery: false });
    harness.controller.start();
    expect(harness.calls).toEqual([]);

    harness.inputs.reachable = true;
    expect(harness.controller.sync().active).toBe(true);

    harness.inputs.enabled = false;
    expect(harness.controller.sync().active).toBe(false);
    expect(harness.active.size).toBe(0);
    // Repeated syncs do not stack assertions.
    harness.inputs.enabled = true;
    harness.controller.sync();
    harness.controller.sync();
    expect(harness.active.size).toBe(1);
  });

  it("re-checks power periodically where power events are not emitted", () => {
    const harness = makeHarness({ enabled: true, reachable: true, onBattery: true });
    harness.controller.start();
    expect(harness.active.size).toBe(0);
    expect(harness.intervals).toHaveLength(1);
    expect(harness.intervals[0]!.ms).toBe(DESKTOP_KEEP_AWAKE_RECHECK_MS);

    harness.inputs.onBattery = false;
    harness.intervals[0]!.callback();
    expect(harness.active.size).toBe(1);
  });

  it("treats an unreadable power source as battery", () => {
    const harness = makeHarness({ enabled: true, reachable: true, onBattery: false });
    Object.defineProperty(harness.inputs, "onBattery", {
      get: () => {
        throw new Error("power source unavailable");
      },
    });
    harness.controller.start();
    expect(harness.active.size).toBe(0);
    expect(harness.controller.state().onBattery).toBe(true);
  });

  it("releases the hold and every listener on dispose", () => {
    const harness = makeHarness({ enabled: true, reachable: true, onBattery: false });
    harness.controller.start();
    harness.controller.dispose();
    expect(harness.active.size).toBe(0);
    expect(harness.intervals[0]!.cleared).toBe(true);
    for (const set of harness.listeners.values()) expect(set.size).toBe(0);
    // A sync after dispose must not reacquire anything.
    expect(harness.controller.sync().active).toBe(false);
  });
});
