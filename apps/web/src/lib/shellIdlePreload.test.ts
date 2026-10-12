import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { markStartupPhase, resetStartupPhasesForTests } from "../perf/startupInstrumentation";
import {
  allowsSpeculativePreload,
  scheduleShellIdlePreloads,
  SHELL_IDLE_PRELOAD_START_CAP_MS,
} from "./shellIdlePreload";

describe("allowsSpeculativePreload", () => {
  it("allows preloads without connection information and on 4g", () => {
    expect(allowsSpeculativePreload(undefined)).toBe(true);
    expect(allowsSpeculativePreload({})).toBe(true);
    expect(allowsSpeculativePreload({ effectiveType: "4g" })).toBe(true);
  });

  it("opts out on data saver and slower networks", () => {
    expect(allowsSpeculativePreload({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(allowsSpeculativePreload({ effectiveType: "3g" })).toBe(false);
    expect(allowsSpeculativePreload({ effectiveType: "slow-2g" })).toBe(false);
  });
});

describe("scheduleShellIdlePreloads", () => {
  beforeEach(() => {
    resetStartupPhasesForTests();
    vi.useFakeTimers();
    // The timer fallback of scheduleIdleTask keeps the order observable.
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for the painted shell, then runs each task in its own idle period, in order", () => {
    const calls: string[] = [];
    scheduleShellIdlePreloads(
      [() => calls.push("thread"), () => calls.push("palette"), () => calls.push("settings")],
      { allowed: true },
    );

    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual([]);

    markStartupPhase("primary-shell-painted");
    vi.advanceTimersToNextTimer();
    expect(calls).toEqual(["thread"]);
    vi.runAllTimers();
    expect(calls).toEqual(["thread", "palette", "settings"]);
  });

  it("starts after the cap when the shell never paints", () => {
    const task = vi.fn();
    scheduleShellIdlePreloads([task], { allowed: true });

    vi.advanceTimersByTime(SHELL_IDLE_PRELOAD_START_CAP_MS - 1);
    expect(task).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(task).toHaveBeenCalledOnce();
  });

  it("keeps going when a task throws", () => {
    const after = vi.fn();
    scheduleShellIdlePreloads(
      [
        () => {
          throw new Error("preload failed");
        },
        after,
      ],
      { allowed: true },
    );
    markStartupPhase("primary-shell-painted");
    vi.runAllTimers();
    expect(after).toHaveBeenCalledOnce();
  });

  it("runs nothing when cancelled or when speculative preloads are not allowed", () => {
    const cancelledTask = vi.fn();
    const cancel = scheduleShellIdlePreloads([cancelledTask], { allowed: true });
    cancel();
    const disallowedTask = vi.fn();
    scheduleShellIdlePreloads([disallowedTask], { allowed: false });

    markStartupPhase("primary-shell-painted");
    vi.runAllTimers();

    expect(cancelledTask).not.toHaveBeenCalled();
    expect(disallowedTask).not.toHaveBeenCalled();
  });
});
