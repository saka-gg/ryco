import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scheduleIdleTask } from "./idleTask";

describe("scheduleIdleTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("defers work to the timer fallback when idle callbacks are unavailable", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const callback = vi.fn();

    scheduleIdleTask(callback);

    expect(callback).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cancels pending idle work", () => {
    const callback = vi.fn();
    const cancel = scheduleIdleTask(callback);

    cancel();
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
  });

  it("uses and cancels a native idle callback when available", () => {
    const scheduled: { callback: (() => void) | null } = { callback: null };
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        scheduled.callback = callback;
        return 42;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const callback = vi.fn();

    const cancel = scheduleIdleTask(callback);
    cancel();
    scheduled.callback?.();

    expect(callback).not.toHaveBeenCalled();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });
});
