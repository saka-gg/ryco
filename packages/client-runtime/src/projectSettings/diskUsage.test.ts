import {
  ProjectId,
  WorktreeId,
  type WorkspaceDiskUsageInput,
  type WorkspaceDiskUsageResult,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  diskSizeText,
  diskText,
  formatDiskSize,
  readDiskUsageProgressively,
  readingTotal,
  sumDiskSizes,
} from "./diskUsage.ts";

const usage = (worktreeId: string, bytes: number | null, partial = false) => ({
  worktreeId: WorktreeId.make(worktreeId),
  main: worktreeId === "main",
  bytes,
  partial,
  measuredAt: "2026-10-13T12:00:00.000Z",
});

describe("disk sizes", () => {
  it("sums measured checkouts, archived ones included, removed ones left out", () => {
    expect(
      sumDiskSizes([
        { disk: { bytes: 1000, partial: false } },
        { disk: { bytes: 200, partial: false } },
        { disk: null, checkoutRemoved: true },
      ]),
    ).toEqual({ bytes: 1200, partial: false });
  });

  it("is a lower bound when a checkout is unmeasured or partial, and null when none is measured", () => {
    expect(sumDiskSizes([{ disk: { bytes: 10, partial: false } }, { disk: null }])).toEqual({
      bytes: 10,
      partial: true,
    });
    expect(sumDiskSizes([{ disk: { bytes: 10, partial: true } }])?.partial).toBe(true);
    expect(sumDiskSizes([{ disk: null }])).toBeNull();
    expect(sumDiskSizes([])).toBeNull();
  });

  it("totals what a device reported", () => {
    expect(
      readingTotal({
        status: "ready",
        refreshing: false,
        workspaces: [usage("main", 1000), usage("wt", 24)],
      }),
    ).toEqual({ bytes: 1024, partial: false });
    expect(
      readingTotal({
        status: "ready",
        refreshing: false,
        workspaces: [usage("main", 1000), usage("wt", null)],
      })?.partial,
    ).toBe(true);
    expect(readingTotal({ status: "loading" })).toBeNull();
  });

  it("says a lower bound as such, and why a figure is missing", () => {
    expect(formatDiskSize({ bytes: 1536 * 1024 * 1024, partial: false })).toBe("1.5 GB");
    expect(formatDiskSize({ bytes: 2048, partial: true })).toBe("≥ 2.0 KB");
    expect(diskSizeText({ bytes: 2048, partial: true })).toBe("At least 2.0 KB");
    expect(diskText(null, { status: "loading" })).toBe("Measuring…");
    expect(diskText(null, { status: "unavailable" })).toBe("Unavailable");
  });
});

describe("readDiskUsageProgressively", () => {
  const projectId = ProjectId.make("project-1");
  const answer = (measuring: boolean | undefined, bytes: number | null) => ({
    workspaces: [{ ...usage("main", bytes), ...(measuring === undefined ? {} : { measuring }) }],
  });

  it("shows the device's last figures at once and reads again until it is done", async () => {
    vi.useFakeTimers();
    try {
      const requests: WorkspaceDiskUsageInput[] = [];
      const answers = [answer(true, 900), answer(true, 900), answer(false, 1000)];
      const results: Array<readonly [number | null, boolean]> = [];
      readDiskUsageProgressively({
        read: async (request) => {
          requests.push(request);
          return answers.shift()!;
        },
        projectId,
        refresh: true,
        onResult: (result, final) => results.push([result.workspaces[0]!.bytes, final]),
        onError: () => {},
      });
      await vi.runAllTimersAsync();
      expect(results).toEqual([
        [900, false],
        [900, false],
        [1000, true],
      ]);
      // Only the first read asks to measure afresh; every read allows an old answer.
      expect(requests).toEqual([
        { projectId, allowStale: true, refresh: true },
        { projectId, allowStale: true },
        { projectId, allowStale: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes an older device's single waited answer as final, and stops when asked", async () => {
    const results: boolean[] = [];
    let reads = 0;
    const read = async (): Promise<WorkspaceDiskUsageResult> => {
      reads += 1;
      return answer(undefined, 5);
    };
    readDiskUsageProgressively({
      read,
      projectId,
      refresh: false,
      onResult: (_, final) => results.push(final),
      onError: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([true]);

    const stop = readDiskUsageProgressively({
      read,
      projectId,
      refresh: false,
      onResult: (_, final) => results.push(final),
      onError: () => {},
    });
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([true]);
    expect(reads).toBe(2);
  });
});
