import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { markStartupPhase, resetStartupPhasesForTests } from "../perf/startupInstrumentation";
import {
  allowsSpeculativePreload,
  scheduleAfterShellPaint,
  scheduleShellIdlePreloads,
  SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS,
  SHELL_IDLE_PRELOAD_START_CAP_MS,
  SHELL_IDLE_PRELOAD_TASK_SETTLE_CAP_MS,
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

  it("holds the next task until the previous task's download settles", async () => {
    const calls: string[] = [];
    let finishThread: () => void = () => undefined;
    scheduleShellIdlePreloads(
      [
        () => {
          calls.push("thread");
          return new Promise<void>((resolve) => {
            finishThread = resolve;
          });
        },
        () => calls.push("palette"),
      ],
      { allowed: true },
    );
    markStartupPhase("primary-shell-painted");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["thread"]);

    finishThread();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["thread", "palette"]);
  });

  it("moves on after the settle cap when a download stalls", async () => {
    const next = vi.fn();
    scheduleShellIdlePreloads([() => new Promise<void>(() => undefined), next], {
      allowed: true,
    });
    markStartupPhase("primary-shell-painted");

    await vi.advanceTimersByTimeAsync(SHELL_IDLE_PRELOAD_TASK_SETTLE_CAP_MS - 1);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not start before a late shell snapshot when a primary shell is expected", () => {
    const task = vi.fn();
    scheduleShellIdlePreloads([task], {
      allowed: true,
      startCapMs: SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS,
    });

    vi.advanceTimersByTime(SHELL_IDLE_PRELOAD_START_CAP_MS + 1_000);
    expect(task).not.toHaveBeenCalled();

    markStartupPhase("primary-shell-painted");
    vi.runAllTimers();
    expect(task).toHaveBeenCalledOnce();
  });

  it("waits for the first thread paint on a thread boot", () => {
    const task = vi.fn();
    scheduleShellIdlePreloads([task], { allowed: true, awaitsFirstThreadPaint: () => true });

    markStartupPhase("primary-shell-painted");
    vi.advanceTimersByTime(1_000);
    expect(task).not.toHaveBeenCalled();

    markStartupPhase("first-thread-painted");
    vi.runAllTimers();
    expect(task).toHaveBeenCalledOnce();
  });

  it("starts at the navigation that leaves a thread that never painted", () => {
    const task = vi.fn();
    const navigationListeners = new Set<() => void>();
    let onThreadRoute = true;
    scheduleShellIdlePreloads([task], {
      allowed: true,
      startCapMs: SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS,
      awaitsFirstThreadPaint: () => onThreadRoute,
      subscribeToNavigation: (listener) => {
        navigationListeners.add(listener);
        return () => navigationListeners.delete(listener);
      },
    });

    markStartupPhase("primary-shell-painted");
    expect(navigationListeners.size).toBe(1);
    // Still on a thread route (another thread): keep waiting for its paint.
    for (const listener of Array.from(navigationListeners)) listener();
    vi.advanceTimersByTime(1_000);
    expect(task).not.toHaveBeenCalled();

    // The thread was gone and the route redirected away.
    onThreadRoute = false;
    for (const listener of Array.from(navigationListeners)) listener();
    expect(navigationListeners.size).toBe(0);
    vi.advanceTimersToNextTimer();
    expect(task).toHaveBeenCalledOnce();
  });

  it("drops the thread paint wait when the cap starts the preloads", () => {
    const task = vi.fn();
    const navigationListeners = new Set<() => void>();
    scheduleShellIdlePreloads([task], {
      allowed: true,
      awaitsFirstThreadPaint: () => true,
      subscribeToNavigation: (listener) => {
        navigationListeners.add(listener);
        return () => navigationListeners.delete(listener);
      },
    });

    markStartupPhase("primary-shell-painted");
    expect(navigationListeners.size).toBe(1);
    vi.advanceTimersByTime(SHELL_IDLE_PRELOAD_START_CAP_MS);
    expect(navigationListeners.size).toBe(0);
    vi.runAllTimers();
    markStartupPhase("first-thread-painted");
    vi.runAllTimers();
    expect(task).toHaveBeenCalledOnce();
  });

  it("starts at the shell paint when the document did not open on a thread", () => {
    const task = vi.fn();
    scheduleShellIdlePreloads([task], { allowed: true, awaitsFirstThreadPaint: () => false });

    markStartupPhase("primary-shell-painted");
    vi.advanceTimersToNextTimer();
    expect(task).toHaveBeenCalledOnce();
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

describe("scheduleAfterShellPaint", () => {
  beforeEach(() => {
    resetStartupPhasesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs one task in an idle period after the painted shell, with its idle timeout", () => {
    const idleCallbacks: Array<{ readonly run: () => void; readonly timeout: number }> = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void, options: { timeout: number }) => {
      idleCallbacks.push({ run, timeout: options.timeout });
      return idleCallbacks.length;
    });
    const task = vi.fn();
    scheduleAfterShellPaint(task, { allowed: true, idleTimeoutMs: 4_000 });
    expect(idleCallbacks).toHaveLength(0);

    markStartupPhase("primary-shell-painted");
    expect(idleCallbacks.map((callback) => callback.timeout)).toEqual([4_000]);
    expect(task).not.toHaveBeenCalled();
    idleCallbacks[0]?.run();
    expect(task).toHaveBeenCalledOnce();
  });

  it("only waits for an idle period once the shell has painted", () => {
    const requestIdleCallback = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    markStartupPhase("primary-shell-painted");

    scheduleAfterShellPaint(vi.fn(), { allowed: true });
    expect(requestIdleCallback).toHaveBeenCalledOnce();
  });

  it("runs nothing when speculative preloads are not allowed", () => {
    const requestIdleCallback = vi.fn(() => 1);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    markStartupPhase("primary-shell-painted");

    scheduleAfterShellPaint(vi.fn(), { allowed: false });
    expect(requestIdleCallback).not.toHaveBeenCalled();
  });
});
