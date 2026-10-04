import { describe, expect, it, vi } from "vitest";

import { createDesktopRelaunchScheduler } from "./desktopRelaunchScheduler";

function makeHarness(activeTurns: number) {
  const state = { activeTurns };
  const listeners = new Set<() => void>();
  const presented: Array<{ readonly activeTurns: number } | null> = [];
  const errors: unknown[] = [];
  const scheduler = createDesktopRelaunchScheduler({
    readActiveTurns: () => state.activeTurns,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    present: (waiting) => presented.push(waiting),
    onError: (error) => errors.push(error),
  });
  const setActiveTurns = (next: number) => {
    state.activeTurns = next;
    for (const listener of listeners) listener();
  };
  return { scheduler, listeners, presented, errors, setActiveTurns };
}

describe("createDesktopRelaunchScheduler", () => {
  it("waits for running turns and relaunches once they finish", async () => {
    const harness = makeHarness(2);
    const relaunch = vi.fn().mockResolvedValue(undefined);
    harness.scheduler.scheduleAfterActiveTurns(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
    expect(harness.presented).toEqual([{ activeTurns: 2 }]);

    // Streaming updates with an unchanged count do not re-render the notice.
    harness.setActiveTurns(2);
    harness.setActiveTurns(1);
    expect(harness.presented).toEqual([{ activeTurns: 2 }, { activeTurns: 1 }]);

    harness.setActiveTurns(0);
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(harness.presented.at(-1)).toBeNull();
    expect(harness.listeners.size).toBe(0);
  });

  it("keeps every deferred change and runs them in order", async () => {
    const harness = makeHarness(1);
    const order: string[] = [];
    harness.scheduler.scheduleAfterActiveTurns(async () => void order.push("origin"));
    harness.scheduler.scheduleAfterActiveTurns(async () => void order.push("node name"));
    expect(harness.scheduler.pendingCount()).toBe(2);

    // Restarting now must not drop the changes that were waiting.
    await harness.scheduler.relaunchNow(async () => void order.push("network"));
    expect(order).toEqual(["origin", "node name", "network"]);
    expect(harness.scheduler.pendingCount()).toBe(0);
  });

  it("cancels deferred changes without running them", () => {
    const harness = makeHarness(1);
    const relaunch = vi.fn().mockResolvedValue(undefined);
    harness.scheduler.scheduleAfterActiveTurns(relaunch);
    harness.scheduler.cancel();
    harness.setActiveTurns(0);
    expect(relaunch).not.toHaveBeenCalled();
    expect(harness.presented).toEqual([{ activeTurns: 1 }, null]);
  });

  it("reports a deferred relaunch that fails after the operator walked away", async () => {
    const harness = makeHarness(1);
    const failure = new Error("relaunch refused");
    harness.scheduler.scheduleAfterActiveTurns(() => Promise.reject(failure));
    harness.setActiveTurns(0);
    await vi.waitFor(() => expect(harness.errors).toEqual([failure]));
  });
});
