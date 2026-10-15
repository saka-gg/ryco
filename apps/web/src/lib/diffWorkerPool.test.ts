import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DIFF_WORKER_POOL_IDLE_TIMEOUT_MS } from "./diffWorkerPoolOwner";

interface FakeStats {
  workersFailed: boolean;
}

const pools = vi.hoisted(
  () =>
    [] as Array<{
      readonly preferredHighlighter: string;
      readonly stats: FakeStats;
      readonly subscribers: Set<(stats: FakeStats) => void>;
      terminated: boolean;
    }>,
);

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: () => Promise.resolve(undefined),
}));

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: function FakeDiffsWorker() {},
}));

vi.mock("@pierre/diffs/worker", () => ({
  WorkerPoolManager: class FakeWorkerPoolManager {
    readonly record;
    constructor(_options: unknown, renderOptions: { readonly preferredHighlighter: string }) {
      this.record = {
        preferredHighlighter: renderOptions.preferredHighlighter,
        stats: { workersFailed: false },
        subscribers: new Set<(stats: FakeStats) => void>(),
        terminated: false,
      };
      pools.push(this.record);
    }
    getStats() {
      return { ...this.record.stats };
    }
    subscribeToStatChanges(callback: (stats: FakeStats) => void) {
      this.record.subscribers.add(callback);
      return () => {
        this.record.subscribers.delete(callback);
      };
    }
    terminate() {
      this.record.terminated = true;
      // Like the library: terminating clears the failure.
      this.record.stats.workersFailed = false;
    }
  },
}));

async function loadDiffWorkerPool() {
  return import("./diffWorkerPool");
}

/** Lets the leased pool go and runs its idle grace to termination. */
function releaseAndExpire(lease: { readonly release: () => void }): void {
  lease.release();
  vi.advanceTimersByTime(DIFF_WORKER_POOL_IDLE_TIMEOUT_MS);
}

describe("diff worker pool highlighter wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    pools.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds the pool with the JS engine when WebAssembly cannot compile", async () => {
    vi.stubGlobal("WebAssembly", {
      ...WebAssembly,
      Module: function BlockedModule() {
        throw new WebAssembly.CompileError("blocked by Content-Security-Policy");
      },
    });
    const { acquireDiffWorkerPool } = await loadDiffWorkerPool();

    acquireDiffWorkerPool("pierre-dark");

    expect(pools.map((pool) => pool.preferredHighlighter)).toEqual(["shiki-js"]);
  });

  it("uses the JS engine for the next pool once a WASM pool reports failed workers", async () => {
    const { acquireDiffWorkerPool } = await loadDiffWorkerPool();

    const first = acquireDiffWorkerPool("pierre-dark");
    expect(pools[0]?.preferredHighlighter).toBe("shiki-wasm");
    pools[0]!.stats.workersFailed = true;
    for (const subscriber of pools[0]!.subscribers) subscriber({ workersFailed: true });
    releaseAndExpire(first);

    acquireDiffWorkerPool("pierre-dark");
    expect(pools.map((pool) => pool.preferredHighlighter)).toEqual(["shiki-wasm", "shiki-js"]);
  });

  it("records a WASM pool failure that no stat broadcast delivered before termination", async () => {
    const { acquireDiffWorkerPool } = await loadDiffWorkerPool();

    const first = acquireDiffWorkerPool("pierre-dark");
    // A hidden tab paints no frame, so the coalesced broadcast never ran.
    pools[0]!.stats.workersFailed = true;
    releaseAndExpire(first);
    expect(pools[0]?.terminated).toBe(true);

    acquireDiffWorkerPool("pierre-dark");
    expect(pools.map((pool) => pool.preferredHighlighter)).toEqual(["shiki-wasm", "shiki-js"]);
  });

  it("keeps WASM for the next pool when the previous one started fine", async () => {
    const { acquireDiffWorkerPool } = await loadDiffWorkerPool();

    releaseAndExpire(acquireDiffWorkerPool("pierre-dark"));
    acquireDiffWorkerPool("pierre-dark");

    expect(pools.map((pool) => pool.preferredHighlighter)).toEqual(["shiki-wasm", "shiki-wasm"]);
  });
});
