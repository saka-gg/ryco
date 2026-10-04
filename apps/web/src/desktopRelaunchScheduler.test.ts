import { describe, expect, it, vi } from "vitest";

import {
  createDesktopRelaunchScheduler,
  type DesktopRelaunchTiming,
} from "./desktopRelaunchScheduler";

function makeHarness(activeTurns: number | null) {
  const state = { activeTurns };
  const listeners = new Set<() => void>();
  const presented: Array<{ readonly activeTurns: number | null } | null> = [];
  const errors: unknown[] = [];
  const restart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const scheduler = createDesktopRelaunchScheduler({
    readActiveTurns: () => state.activeTurns,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    present: (waiting) => presented.push(waiting),
    restart,
    onError: (error) => errors.push(error),
  });
  const setActiveTurns = (next: number | null) => {
    state.activeTurns = next;
    for (const listener of listeners) listener();
  };
  return { scheduler, listeners, presented, errors, restart, setActiveTurns };
}

function recordingChange() {
  const timings: DesktopRelaunchTiming[] = [];
  const change = vi.fn(async (timing: DesktopRelaunchTiming) => {
    timings.push(timing);
  });
  return { change, timings };
}

describe("createDesktopRelaunchScheduler", () => {
  it("saves a deferred change at once and relaunches once the turns finish", async () => {
    const harness = makeHarness(2);
    const { change, timings } = recordingChange();
    await harness.scheduler.scheduleAfterActiveTurns(change);
    // Saved before waiting: quitting, crashing, or updating first cannot drop it.
    expect(timings).toEqual(["deferred"]);
    expect(harness.restart).not.toHaveBeenCalled();
    expect(harness.presented).toEqual([{ activeTurns: 2 }]);

    // Streaming updates with an unchanged count do not re-render the notice.
    harness.setActiveTurns(2);
    harness.setActiveTurns(1);
    expect(harness.presented).toEqual([{ activeTurns: 2 }, { activeTurns: 1 }]);

    harness.setActiveTurns(0);
    await vi.waitFor(() => expect(harness.restart).toHaveBeenCalledOnce());
    expect(timings).toEqual(["deferred"]);
    expect(harness.presented.at(-1)).toBeNull();
    expect(harness.listeners.size).toBe(0);
    expect(harness.scheduler.pending()).toBe(false);
  });

  it("arms nothing when the change could not be saved", async () => {
    const harness = makeHarness(1);
    const failure = new Error("No reachable network address");
    await expect(
      harness.scheduler.scheduleAfterActiveTurns(() => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(harness.scheduler.pending()).toBe(false);
    expect(harness.presented).toEqual([]);
    harness.setActiveTurns(0);
    expect(harness.restart).not.toHaveBeenCalled();
  });

  it("carries every saved change into one relaunch", async () => {
    const harness = makeHarness(1);
    const first = recordingChange();
    const second = recordingChange();
    await harness.scheduler.scheduleAfterActiveTurns(first.change);
    await harness.scheduler.scheduleAfterActiveTurns(second.change);
    expect(first.timings).toEqual(["deferred"]);
    expect(second.timings).toEqual(["deferred"]);

    harness.setActiveTurns(0);
    await vi.waitFor(() => expect(harness.restart).toHaveBeenCalledOnce());
  });

  it("restarts for saved changes even when a later change applies now", async () => {
    // The later change may need no relaunch of its own; the saved ones still do.
    const harness = makeHarness(1);
    await harness.scheduler.scheduleAfterActiveTurns(recordingChange().change);
    const now = recordingChange();
    await harness.scheduler.relaunchNow(now.change);
    expect(now.timings).toEqual(["now"]);
    expect(harness.restart).toHaveBeenCalledOnce();
    expect(harness.scheduler.pending()).toBe(false);

    const alone = makeHarness(0);
    await alone.scheduler.relaunchNow(recordingChange().change);
    expect(alone.restart).not.toHaveBeenCalled();
    await alone.scheduler.relaunchNow();
    expect(alone.restart).toHaveBeenCalledOnce();
  });

  it("stops waiting on cancel; the saved change stays saved", async () => {
    const harness = makeHarness(1);
    const { change, timings } = recordingChange();
    await harness.scheduler.scheduleAfterActiveTurns(change);
    harness.scheduler.cancel();
    harness.setActiveTurns(0);
    expect(timings).toEqual(["deferred"]);
    expect(harness.restart).not.toHaveBeenCalled();
    expect(harness.presented).toEqual([{ activeTurns: 1 }, null]);
  });

  it("keeps waiting while the running turns cannot be counted", async () => {
    const harness = makeHarness(null);
    await harness.scheduler.scheduleAfterActiveTurns(recordingChange().change);
    expect(harness.presented).toEqual([{ activeTurns: null }]);
    expect(harness.restart).not.toHaveBeenCalled();
    harness.setActiveTurns(0);
    await vi.waitFor(() => expect(harness.restart).toHaveBeenCalledOnce());
  });

  it("reports a deferred relaunch that fails after the operator walked away", async () => {
    const harness = makeHarness(1);
    const failure = new Error("relaunch refused");
    harness.restart.mockRejectedValueOnce(failure);
    await harness.scheduler.scheduleAfterActiveTurns(recordingChange().change);
    harness.setActiveTurns(0);
    await vi.waitFor(() => expect(harness.errors).toEqual([failure]));
  });
});
