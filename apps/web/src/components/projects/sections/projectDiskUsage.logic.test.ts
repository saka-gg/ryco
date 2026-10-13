import { WorktreeId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  diskSizeText,
  diskText,
  formatDiskSize,
  readingTotal,
  sumDiskSizes,
} from "./projectDiskUsage.logic";

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
