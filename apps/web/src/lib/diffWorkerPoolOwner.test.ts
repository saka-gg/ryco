import { describe, expect, it } from "vite-plus/test";

import {
  createDiffWorkerPoolOwner,
  DIFF_WORKER_POOL_HIDDEN_IDLE_TIMEOUT_MS,
  DIFF_WORKER_POOL_IDLE_TIMEOUT_MS,
  resolveDiffWorkerPoolSize,
} from "./diffWorkerPoolOwner";

function createHarness() {
  const created: Array<{ id: number; theme: string }> = [];
  const terminated: number[] = [];
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let nextTimer = 1;
  let hidden = false;
  const owner = createDiffWorkerPoolOwner<{ id: number; theme: string }>({
    create: (theme) => {
      const pool = { id: created.length + 1, theme };
      created.push(pool);
      return pool;
    },
    terminate: (pool) => terminated.push(pool.id),
    isDocumentHidden: () => hidden,
    setTimer: (callback, delayMs) => {
      const id = nextTimer++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
  });
  return {
    owner,
    created,
    terminated,
    timers,
    setHidden: (value: boolean) => {
      hidden = value;
    },
    fireTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

describe("createDiffWorkerPoolOwner", () => {
  it("shares one pool across leases and keeps it while any lease is held", () => {
    const harness = createHarness();
    const first = harness.owner.acquire("pierre-dark");
    const second = harness.owner.acquire("pierre-dark");
    expect(first.pool).toBe(second.pool);
    expect(harness.created).toHaveLength(1);
    expect(harness.timers.size).toBe(0);

    first.release();
    expect(harness.timers.size).toBe(0);
    second.release();
    expect([...harness.timers.values()].map((timer) => timer.delayMs)).toEqual([
      DIFF_WORKER_POOL_IDLE_TIMEOUT_MS,
    ]);
    expect(harness.terminated).toEqual([]);
  });

  it("keeps warm workers across a close and reopen inside the idle grace", () => {
    const harness = createHarness();
    harness.owner.acquire("pierre-dark").release();
    const reopened = harness.owner.acquire("pierre-dark");
    expect(harness.created).toHaveLength(1);
    expect(harness.timers.size).toBe(0);
    reopened.release();
  });

  it("terminates after the idle grace and creates a fresh pool on the next lease", () => {
    const harness = createHarness();
    harness.owner.acquire("pierre-dark").release();
    harness.fireTimers();
    expect(harness.terminated).toEqual([1]);
    expect(harness.owner.peek()).toBeNull();

    const next = harness.owner.acquire("pierre-light");
    expect(next.pool).toEqual({ id: 2, theme: "pierre-light" });
  });

  it("uses the shorter grace while the document is hidden", () => {
    const harness = createHarness();
    harness.owner.acquire("pierre-dark").release();
    harness.setHidden(true);
    harness.owner.onVisibilityChange();
    expect([...harness.timers.values()].map((timer) => timer.delayMs)).toEqual([
      DIFF_WORKER_POOL_HIDDEN_IDLE_TIMEOUT_MS,
    ]);
  });

  it("retires a pool that was created but never leased", () => {
    const harness = createHarness();
    harness.owner.get("pierre-dark");
    expect(harness.timers.size).toBe(1);
    harness.fireTimers();
    expect(harness.terminated).toEqual([1]);
  });

  it("ignores double releases", () => {
    const harness = createHarness();
    const first = harness.owner.acquire("pierre-dark");
    const second = harness.owner.acquire("pierre-dark");
    first.release();
    first.release();
    expect(harness.timers.size).toBe(0);
    second.release();
    expect(harness.timers.size).toBe(1);
  });
});

describe("resolveDiffWorkerPoolSize", () => {
  it("uses at most two workers and at least one", () => {
    expect(resolveDiffWorkerPoolSize(undefined)).toBe(1);
    expect(resolveDiffWorkerPoolSize(2)).toBe(1);
    expect(resolveDiffWorkerPoolSize(8)).toBe(2);
    expect(resolveDiffWorkerPoolSize(32)).toBe(2);
  });
});
