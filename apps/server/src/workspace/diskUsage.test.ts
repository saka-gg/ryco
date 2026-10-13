import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type DiskUsageMeasurement,
  exclusiveDiskUsage,
  makeDiskUsageCache,
  measureDiskUsage,
} from "./diskUsage.ts";

const usage = (bytes: number | null, partial = false): DiskUsageMeasurement => ({
  bytes,
  partial,
});

describe("exclusiveDiskUsage", () => {
  it("subtracts a nested checkout from the nearest checkout holding it", () => {
    const result = exclusiveDiskUsage([
      { path: "/repo", usage: usage(1000) },
      { path: "/repo/.worktrees/a", usage: usage(300) },
      { path: "/repo/.worktrees/a/inner", usage: usage(100) },
      { path: "/elsewhere/b", usage: usage(50) },
    ]);
    expect(result.map((entry) => entry.bytes)).toEqual([700, 200, 100, 50]);
    expect(result.every((entry) => !entry.partial)).toBe(true);
  });

  it("marks the parent partial when a nested checkout could not be measured", () => {
    const result = exclusiveDiskUsage([
      { path: "/repo", usage: usage(1000) },
      { path: "/repo/wt", usage: usage(null, true) },
    ]);
    expect(result[0]).toEqual({ bytes: 1000, partial: true });
  });

  it("does not treat a sibling with a shared prefix as nested", () => {
    const result = exclusiveDiskUsage([
      { path: "/repo", usage: usage(1000) },
      { path: "/repo-wt", usage: usage(300) },
    ]);
    expect(result.map((entry) => entry.bytes)).toEqual([1000, 300]);
  });
});

describe("makeDiskUsageCache", () => {
  it("answers from the cache within the TTL and measures again on refresh", async () => {
    let clock = 0;
    let calls = 0;
    const cache = makeDiskUsageCache({
      measure: async () => usage(++calls * 10),
      ttlMs: 100,
      now: () => clock,
    });
    expect((await cache.read("/a", false)).usage.bytes).toBe(10);
    clock = 50;
    expect((await cache.read("/a", false)).usage.bytes).toBe(10);
    expect((await cache.read("/a", true)).usage.bytes).toBe(20);
    clock = 200;
    expect((await cache.read("/a", false)).usage.bytes).toBe(30);
  });

  it("shares a measurement in flight and bounds how many run at once", async () => {
    let running = 0;
    let peak = 0;
    const measured: string[] = [];
    const cache = makeDiskUsageCache({
      concurrency: 2,
      measure: async (root) => {
        measured.push(root);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return usage(1);
      },
    });
    await Promise.all([
      cache.read("/a", false),
      cache.read("/a", true),
      cache.read("/b", false),
      cache.read("/c", false),
    ]);
    expect(measured).toHaveLength(3);
    expect(peak).toBe(2);
  });

  it("reports a failed measurement as unmeasured", async () => {
    const cache = makeDiskUsageCache({
      measure: async () => {
        throw new Error("boom");
      },
    });
    expect((await cache.read("/a", false)).usage).toEqual({ bytes: null, partial: true });
  });
});

describe("measureDiskUsage", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("measures a folder on disk", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ryco-disk-usage-"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "file.bin"), Buffer.alloc(256 * 1024));
    const measured = await measureDiskUsage(root);
    expect(measured.partial).toBe(false);
    expect(measured.bytes).toBeGreaterThanOrEqual(256 * 1024);
  });

  it("reports a missing folder as unmeasured", async () => {
    const measured = await measureDiskUsage(path.join(os.tmpdir(), "ryco-disk-usage-missing-x"));
    expect(measured.bytes).toBeNull();
  });
});
