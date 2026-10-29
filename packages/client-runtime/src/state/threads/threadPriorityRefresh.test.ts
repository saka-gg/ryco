import {
  EnvironmentId,
  ThreadPriorityBatchId,
  type ThreadPriorityEnsureCurrentResult,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getThreadPriorityRefreshCoordinator,
  sameThreadPriorityRefreshEnvironments,
  THREAD_PRIORITY_CHANGE_QUIET_MS,
  THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS,
  type ThreadPriorityRefreshEnvironment,
  type ThreadPriorityRefreshTimer,
} from "./threadPriorityRefresh.ts";

class FakeTimer implements ThreadPriorityRefreshTimer {
  nowMs = 0;
  nextId = 1;
  tasks = new Map<number, { readonly atMs: number; readonly callback: () => void }>();

  set = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.tasks.set(id, { atMs: this.nowMs + delayMs, callback });
    return id;
  };

  clear = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  async advance(amountMs: number): Promise<void> {
    const target = this.nowMs + amountMs;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.atMs <= target)
        .toSorted((left, right) => left[1].atMs - right[1].atMs)[0];
      if (next === undefined) break;
      this.nowMs = next[1].atMs;
      this.tasks.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
  }
}

function environment(
  id: string,
  overrides: Partial<ThreadPriorityRefreshEnvironment> = {},
): ThreadPriorityRefreshEnvironment {
  return {
    environmentId: EnvironmentId.make(id),
    generation: 1,
    connected: true,
    supported: true,
    ...overrides,
  };
}

function result(atMs: number): ThreadPriorityEnsureCurrentResult {
  const checkedAt = new Date(atMs).toISOString();
  return {
    batchId: ThreadPriorityBatchId.make(`batch-${atMs}`),
    disposition: "cache-hit",
    freshness: { rankedAt: checkedAt, usableUntil: checkedAt, checkedAt },
  };
}

function harness(initialEnvironments: ThreadPriorityRefreshEnvironment[]) {
  const timer = new FakeTimer();
  let environments = initialEnvironments;
  const calls: Array<{ environmentId: EnvironmentId; force: boolean }> = [];
  let implementation = async (environmentId: EnvironmentId, force: boolean) => {
    calls.push({ environmentId, force });
    return result(timer.nowMs);
  };
  const runtime = {};
  const coordinator = getThreadPriorityRefreshCoordinator(runtime, {
    nowMs: () => timer.nowMs,
    timer,
    listEnvironments: () => environments,
    ensureCurrent: (environmentId, input) => implementation(environmentId, input.force),
  });
  return {
    runtime,
    timer,
    coordinator,
    calls,
    setEnvironments: (next: ThreadPriorityRefreshEnvironment[]) => {
      environments = next;
    },
    setImplementation: (
      next: (
        environmentId: EnvironmentId,
        force: boolean,
      ) => Promise<ThreadPriorityEnsureCurrentResult>,
    ) => {
      implementation = next;
    },
  };
}

describe("thread priority refresh coordinator", () => {
  it("refreshes connected supported environments on enable and defaults to ten minutes", async () => {
    const supported = environment("supported");
    const disconnected = environment("disconnected", { connected: false });
    const unsupported = environment("unsupported", { supported: false });
    const test = harness([supported, disconnected, unsupported]);
    await test.coordinator.configure({
      enabled: true,
      intervalMs: THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS,
    });
    expect(test.calls).toEqual([{ environmentId: supported.environmentId, force: false }]);
    await test.timer.advance(THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS - 1);
    expect(test.calls).toHaveLength(1);
    await test.timer.advance(1);
    expect(test.calls).toHaveLength(2);
  });

  it("keeps interval zero manual-only after the initial enablement refresh", async () => {
    const test = harness([environment("node")]);
    await test.coordinator.configure({ enabled: true, intervalMs: 0 });
    await test.timer.advance(24 * 60 * 60_000);
    await test.coordinator.setForeground(false);
    await test.coordinator.setForeground(true);
    test.coordinator.relevantInputChanged();
    await test.timer.advance(THREAD_PRIORITY_CHANGE_QUIET_MS);
    expect(test.calls).toHaveLength(1);
    const manual = await test.coordinator.refreshNow();
    expect(test.calls.at(-1)?.force).toBe(true);
    expect(manual.succeeded).toEqual([EnvironmentId.make("node")]);
  });

  it("cancels timers in background and refreshes only stale environments on foreground", async () => {
    const fresh = environment("fresh", { lastSuccessfulCheckAtMs: 0 });
    const stale = environment("stale", {
      lastSuccessfulCheckAtMs: -THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS,
    });
    const test = harness([fresh, stale]);
    await test.coordinator.configure({
      enabled: true,
      intervalMs: THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS,
    });
    test.calls.splice(0);
    await test.coordinator.setForeground(false);
    expect(test.timer.tasks.size).toBe(0);
    await test.timer.advance(THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS);
    await test.coordinator.setForeground(true);
    expect(test.calls.map((call) => call.environmentId).toSorted()).toEqual(
      [fresh.environmentId, stale.environmentId].toSorted(),
    );
  });

  it("waits for change quiet and still respects the configured interval", async () => {
    const node = environment("node");
    const test = harness([node]);
    await test.coordinator.configure({ enabled: true, intervalMs: 300_000 });
    test.coordinator.relevantInputChanged();
    await test.timer.advance(THREAD_PRIORITY_CHANGE_QUIET_MS);
    expect(test.calls).toHaveLength(1);
    await test.timer.advance(300_000 - THREAD_PRIORITY_CHANGE_QUIET_MS);
    expect(test.calls).toHaveLength(2);
  });

  it("skips disconnected nodes without acquiring them and refreshes after connection", async () => {
    const disconnected = environment("node", { connected: false });
    const test = harness([disconnected]);
    await test.coordinator.configure({ enabled: true, intervalMs: 600_000 });
    expect(test.calls).toEqual([]);
    test.setEnvironments([{ ...disconnected, connected: true, generation: 2 }]);
    await test.coordinator.environmentsChanged();
    expect(test.calls).toEqual([{ environmentId: disconnected.environmentId, force: false }]);
  });

  it("ignores stale completion acknowledgements after generation replacement", async () => {
    const first = environment("node", { generation: 1 });
    const test = harness([first]);
    let resolve!: (value: ThreadPriorityEnsureCurrentResult) => void;
    test.setImplementation(
      (environmentId, force) =>
        new Promise((done) => {
          test.calls.push({ environmentId, force });
          resolve = done;
        }),
    );
    const enabling = test.coordinator.configure({ enabled: true, intervalMs: 600_000 });
    await Promise.resolve();
    test.setEnvironments([{ ...first, generation: 2 }]);
    resolve(result(test.timer.nowMs));
    await enabling;
    expect(test.coordinator.getLastSuccessfulCheckAtMs(first.environmentId)).toBeNull();
  });

  it("shares one coordinator across UI consumers for the same runtime", () => {
    const test = harness([environment("node")]);
    const same = getThreadPriorityRefreshCoordinator(test.runtime, {
      nowMs: () => test.timer.nowMs,
      timer: test.timer,
      listEnvironments: () => [],
      ensureCurrent: async () => result(test.timer.nowMs),
    });
    expect(same).toBe(test.coordinator);
  });

  it("returns per-environment failures from manual refresh", async () => {
    const failing = environment("failing");
    const test = harness([failing]);
    test.setImplementation(async (environmentId, force) => {
      test.calls.push({ environmentId, force });
      throw new Error("provider unavailable");
    });
    const manual = await test.coordinator.refreshNow();
    expect(manual.attempted).toEqual([failing.environmentId]);
    expect(manual.succeeded).toEqual([]);
    expect(manual.failures[0]).toMatchObject({ environmentId: failing.environmentId });
  });
});

describe("sameThreadPriorityRefreshEnvironments", () => {
  // The mobile bridge rebuilds the list on every socket status write; only a
  // change in a field the coordinator reads may wake it.
  it("compares the fields the coordinator decides on, in order", () => {
    const list = [environment("a"), environment("b", { supported: false })];
    expect(
      sameThreadPriorityRefreshEnvironments(list, [
        environment("a"),
        environment("b", { supported: false }),
      ]),
    ).toBe(true);
    expect(sameThreadPriorityRefreshEnvironments([], [])).toBe(true);

    for (const changed of [
      [environment("a", { generation: 2 }), list[1]!],
      [environment("a", { connected: false }), list[1]!],
      [environment("a"), environment("b")],
      [environment("a", { lastSuccessfulCheckAtMs: 5 }), list[1]!],
      [list[1]!, list[0]!],
      [list[0]!],
    ]) {
      expect(sameThreadPriorityRefreshEnvironments(list, changed)).toBe(false);
    }
  });
});
