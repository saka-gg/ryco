import { describe, expect, it } from "vite-plus/test";

import type { DesktopKeepAwakeMode } from "@ryco/contracts";

import {
  BackendAgentWorkTracker,
  DESKTOP_AGENT_WORK_EXIT_HOLD_MS,
  DESKTOP_KEEP_AWAKE_RECHECK_MS,
  DesktopKeepAwakeController,
  type DesktopKeepAwakeInputs,
  desktopKeepAwakeReason,
  isDesktopNodeReachable,
} from "./desktopKeepAwake.ts";

function makeHarness(initial: {
  mode: DesktopKeepAwakeMode;
  reachable: boolean;
  onBattery: boolean;
  agentWorking?: boolean;
}) {
  const inputs = { agentWorking: false, ...initial };
  const active = new Set<number>();
  const calls: string[] = [];
  const changes: Array<[boolean, string | null]> = [];
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
    read: () => ({
      mode: inputs.mode,
      reachable: inputs.reachable,
      agentWorking: inputs.agentWorking,
    }),
    onChange: (activeNow, reason) => {
      changes.push([activeNow, reason]);
    },
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
  return { controller, inputs, active, calls, changes, listeners, intervals, emit };
}

const inputs = (overrides: Partial<DesktopKeepAwakeInputs> = {}): DesktopKeepAwakeInputs => ({
  mode: "reachable-or-working",
  reachable: false,
  agentWorking: false,
  onBattery: false,
  ...overrides,
});

describe("desktopKeepAwakeReason", () => {
  it("holds a reachable node, or a working one in the agent mode, on AC power only", () => {
    expect(desktopKeepAwakeReason(inputs({ reachable: true }))).toBe("reachable");
    expect(desktopKeepAwakeReason(inputs({ agentWorking: true }))).toBe("agent-work");
    // Reachability wins when both apply.
    expect(desktopKeepAwakeReason(inputs({ reachable: true, agentWorking: true }))).toBe(
      "reachable",
    );
    expect(desktopKeepAwakeReason(inputs())).toBeNull();
    expect(
      desktopKeepAwakeReason(inputs({ reachable: true, agentWorking: true, onBattery: true })),
    ).toBeNull();

    expect(desktopKeepAwakeReason(inputs({ mode: "reachable", reachable: true }))).toBe(
      "reachable",
    );
    expect(desktopKeepAwakeReason(inputs({ mode: "reachable", agentWorking: true }))).toBeNull();

    expect(
      desktopKeepAwakeReason(inputs({ mode: "off", reachable: true, agentWorking: true })),
    ).toBeNull();
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
    const harness = makeHarness({ mode: "reachable", reachable: true, onBattery: false });
    harness.controller.start();
    expect(harness.calls).toEqual(["start:prevent-app-suspension"]);
    expect(harness.controller.state()).toEqual({
      mode: "reachable",
      reachable: true,
      agentWorking: false,
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
    const harness = makeHarness({ mode: "reachable", reachable: false, onBattery: false });
    harness.controller.start();
    expect(harness.calls).toEqual([]);

    harness.inputs.reachable = true;
    expect(harness.controller.sync().active).toBe(true);

    harness.inputs.mode = "off";
    expect(harness.controller.sync().active).toBe(false);
    expect(harness.active.size).toBe(0);
    // Repeated syncs do not stack assertions.
    harness.inputs.mode = "reachable";
    harness.controller.sync();
    harness.controller.sync();
    expect(harness.active.size).toBe(1);
  });

  it("re-checks power periodically where power events are not emitted", () => {
    const harness = makeHarness({ mode: "reachable", reachable: true, onBattery: true });
    harness.controller.start();
    expect(harness.active.size).toBe(0);
    expect(harness.intervals).toHaveLength(1);
    expect(harness.intervals[0]!.ms).toBe(DESKTOP_KEEP_AWAKE_RECHECK_MS);

    harness.inputs.onBattery = false;
    harness.intervals[0]!.callback();
    expect(harness.active.size).toBe(1);
  });

  it("treats an unreadable power source as battery", () => {
    const harness = makeHarness({ mode: "reachable", reachable: true, onBattery: false });
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
    const harness = makeHarness({ mode: "reachable", reachable: true, onBattery: false });
    harness.controller.start();
    harness.controller.dispose();
    expect(harness.active.size).toBe(0);
    expect(harness.intervals[0]!.cleared).toBe(true);
    for (const set of harness.listeners.values()) expect(set.size).toBe(0);
    // A sync after dispose must not reacquire anything.
    expect(harness.controller.sync().active).toBe(false);
  });
});

describe("DesktopKeepAwakeController with agent work", () => {
  it("holds a local-only desktop awake on AC while agents work", () => {
    // Before this, only reachability could hold the machine: a local-only desktop on AC power
    // idle-slept in the middle of a turn.
    const harness = makeHarness({
      mode: "reachable-or-working",
      reachable: false,
      onBattery: false,
    });
    harness.controller.start();
    expect(harness.active.size).toBe(0);

    harness.inputs.agentWorking = true;
    expect(harness.controller.sync()).toEqual({
      mode: "reachable-or-working",
      reachable: false,
      agentWorking: true,
      onBattery: false,
      active: true,
    });
    expect(harness.calls).toEqual(["start:prevent-app-suspension"]);

    harness.inputs.agentWorking = false;
    expect(harness.controller.sync().active).toBe(false);
    expect(harness.active.size).toBe(0);
    expect(harness.changes).toEqual([
      [true, "agent-work"],
      [false, null],
    ]);
  });

  it("ignores agent work in the reachable mode and holds nothing when off", () => {
    const reachableOnly = makeHarness({
      mode: "reachable",
      reachable: false,
      onBattery: false,
      agentWorking: true,
    });
    reachableOnly.controller.start();
    expect(reachableOnly.active.size).toBe(0);

    const off = makeHarness({ mode: "off", reachable: true, onBattery: false, agentWorking: true });
    off.controller.start();
    expect(off.active.size).toBe(0);
    expect(off.controller.state().active).toBe(false);
  });

  it("does not hold on battery while agents work, and holds again on AC", () => {
    const harness = makeHarness({
      mode: "reachable-or-working",
      reachable: false,
      onBattery: true,
      agentWorking: true,
    });
    harness.controller.start();
    expect(harness.active.size).toBe(0);

    harness.inputs.onBattery = false;
    harness.emit("on-ac");
    expect(harness.active.size).toBe(1);
    expect(harness.changes).toEqual([[true, "agent-work"]]);
  });

  it("reports the reason that acquired the hold, and only acquire and release", () => {
    const harness = makeHarness({
      mode: "reachable-or-working",
      reachable: true,
      onBattery: false,
      agentWorking: true,
    });
    harness.controller.start();
    // Reachability goes away while agents still work: the hold stays, nothing is reported.
    harness.inputs.reachable = false;
    harness.controller.sync();
    harness.inputs.agentWorking = false;
    harness.controller.sync();
    expect(harness.changes).toEqual([
      [true, "reachable"],
      [false, null],
    ]);
  });
});

function makeTracker(exitHoldMs?: number) {
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  let changes = 0;
  const tracker = new BackendAgentWorkTracker({
    onChange: () => {
      changes += 1;
    },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref: () => undefined };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    ...(exitHoldMs === undefined ? {} : { exitHoldMs }),
  });
  const fire = (timer: { callback: () => void; cleared: boolean }) => {
    if (!timer.cleared) timer.callback();
  };
  return { tracker, timers, fire, changes: () => changes };
}

describe("BackendAgentWorkTracker", () => {
  it("follows the current backend's reports and notifies only on changes", () => {
    const { tracker, changes } = makeTracker();
    const child = {};
    tracker.begin(child);
    expect(tracker.agentWorking).toBe(false);
    tracker.report(child, true);
    tracker.report(child, true);
    expect(tracker.agentWorking).toBe(true);
    tracker.report(child, false);
    expect(tracker.agentWorking).toBe(false);
    expect(changes()).toBe(2);
  });

  it("drops reports from a replaced or exited backend", () => {
    const { tracker } = makeTracker();
    const first = {};
    const second = {};
    tracker.begin(first);
    tracker.end(first, { holdIfWorking: false });
    // Drained from the first child's pipe after its exit.
    tracker.report(first, true);
    expect(tracker.agentWorking).toBe(false);

    tracker.begin(second);
    tracker.report(first, true);
    expect(tracker.agentWorking).toBe(false);
    tracker.report(second, true);
    tracker.report(first, false);
    expect(tracker.agentWorking).toBe(true);
  });

  it("keeps a crashed backend's work for the release tail while its successor starts", () => {
    const { tracker, timers, fire, changes } = makeTracker();
    const crashed = {};
    const successor = {};
    tracker.begin(crashed);
    tracker.report(crashed, true);
    tracker.end(crashed, { holdIfWorking: true });
    expect(tracker.agentWorking).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(DESKTOP_AGENT_WORK_EXIT_HOLD_MS);

    tracker.begin(successor);
    expect(tracker.agentWorking).toBe(true);
    // The successor's first report comes before it continues the interrupted turns.
    tracker.report(successor, false);
    expect(tracker.agentWorking).toBe(true);

    fire(timers[0]!);
    expect(tracker.agentWorking).toBe(false);
    expect(changes()).toBe(2);
  });

  it("hands over to a successor that reports work", () => {
    const { tracker, timers, fire } = makeTracker();
    const crashed = {};
    const successor = {};
    tracker.begin(crashed);
    tracker.report(crashed, true);
    tracker.end(crashed, { holdIfWorking: true });
    tracker.begin(successor);
    tracker.report(successor, true);
    expect(timers[0]!.cleared).toBe(true);
    fire(timers[0]!);
    expect(tracker.agentWorking).toBe(true);
    tracker.report(successor, false);
    expect(tracker.agentWorking).toBe(false);
  });

  it("releases at once when Ryco quits or the backend was idle", () => {
    const quitting = makeTracker();
    const child = {};
    quitting.tracker.begin(child);
    quitting.tracker.report(child, true);
    quitting.tracker.end(child, { holdIfWorking: false });
    expect(quitting.tracker.agentWorking).toBe(false);
    expect(quitting.timers).toHaveLength(0);

    const idle = makeTracker();
    idle.tracker.begin(child);
    idle.tracker.report(child, false);
    idle.tracker.end(child, { holdIfWorking: true });
    expect(idle.tracker.agentWorking).toBe(false);
    expect(idle.timers).toHaveLength(0);
  });

  it("does not extend the tail when successors keep exiting before they report", () => {
    const { tracker, timers, fire } = makeTracker();
    const crashed = {};
    tracker.begin(crashed);
    tracker.report(crashed, true);
    tracker.end(crashed, { holdIfWorking: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const successor = {};
      tracker.begin(successor);
      tracker.end(successor, { holdIfWorking: true });
    }
    expect(timers).toHaveLength(1);
    fire(timers[0]!);
    expect(tracker.agentWorking).toBe(false);
  });

  it("forgets everything on dispose without notifying", () => {
    const { tracker, timers, changes } = makeTracker();
    const child = {};
    tracker.begin(child);
    tracker.report(child, true);
    tracker.end(child, { holdIfWorking: true });
    const before = changes();
    tracker.dispose();
    expect(tracker.agentWorking).toBe(false);
    expect(timers[0]!.cleared).toBe(true);
    expect(changes()).toBe(before);
  });
});
