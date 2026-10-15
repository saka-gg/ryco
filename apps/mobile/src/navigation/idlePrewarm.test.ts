import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PREWARM_MODULES_PER_SLICE, prewarmInIdleSlices } from "./idlePrewarm";

const idle: Array<() => void> = [];

beforeEach(() => {
  idle.length = 0;
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    idle.push(callback);
    return idle.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runNextIdleSlice(): void {
  const slice = idle.shift();
  if (!slice) throw new Error("no idle slice is scheduled");
  slice();
}

describe("prewarmInIdleSlices", () => {
  it("evaluates nothing until idle, then a bounded batch per idle slice", () => {
    const modules = Array.from({ length: PREWARM_MODULES_PER_SLICE + 2 }, () => vi.fn());
    const done = vi.fn();

    prewarmInIdleSlices(modules, done);
    expect(modules.some((module) => module.mock.calls.length > 0)).toBe(false);

    runNextIdleSlice();
    expect(modules.filter((module) => module.mock.calls.length === 1)).toHaveLength(
      PREWARM_MODULES_PER_SLICE,
    );
    expect(done).not.toHaveBeenCalled();

    runNextIdleSlice();
    expect(modules.every((module) => module.mock.calls.length === 1)).toBe(true);
    expect(done).toHaveBeenCalledOnce();
    expect(idle).toEqual([]);
  });

  it("keeps warming the rest when one module fails to evaluate", () => {
    const failing = vi.fn(() => {
      throw new Error("module factory threw");
    });
    const after = vi.fn();
    const done = vi.fn();

    prewarmInIdleSlices([failing, after], done);
    expect(runNextIdleSlice).not.toThrow();

    expect(failing).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  it("finishes an empty warm-up in one idle slice", () => {
    const done = vi.fn();
    prewarmInIdleSlices([], done);
    runNextIdleSlice();
    expect(done).toHaveBeenCalledOnce();
  });
});
