import type { DiagnosticsEventLoopHistory, DiagnosticsEventLoopStall } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  stallHint,
  stallRows,
  summarizeEventLoopHistory,
} from "./EventLoopStallsDiagnostics.logic";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");

const stall = (overrides: Partial<DiagnosticsEventLoopStall> = {}): DiagnosticsEventLoopStall => ({
  time: new Date(NOW - 60_000).toISOString(),
  kind: "event-loop",
  durationMs: 4_000,
  count: 1,
  totalMs: 4_000,
  uptimeMs: 3_600_000,
  ...overrides,
});

const history = (
  recent: ReadonlyArray<DiagnosticsEventLoopStall>,
  last24h = { records: recent.length, stalls: recent.length, longestMs: 0, threadpoolStalls: 0 },
): DiagnosticsEventLoopHistory => ({
  thresholdMs: 2_000,
  windowMs: 30_000,
  historyFilePaths: ["/logs/event-loop-stalls.ndjson", "/logs/event-loop-stalls.ndjson.1"],
  recent,
  last24h,
});

describe("summarizeEventLoopHistory", () => {
  it("says when the node's server does not record stalls", () => {
    expect(summarizeEventLoopHistory(undefined, NOW)).toMatchObject({
      state: "unsupported",
      headline: "This node's server does not record stalls. Update it to see them here.",
    });
  });

  it("reports an empty history with the threshold", () => {
    expect(summarizeEventLoopHistory(history([]), NOW)).toMatchObject({
      state: "empty",
      headline: "No stalls of 2 s or more recorded",
    });
  });

  it("counts the last day's stalls and names the longest", () => {
    const summary = summarizeEventLoopHistory(
      history([stall({ durationMs: 6_200 }), stall({ kind: "threadpool" })], {
        records: 2,
        stalls: 3,
        longestMs: 6_200,
        threadpoolStalls: 1,
      }),
      NOW,
    );
    expect(summary).toEqual({
      state: "stalls",
      headline: "3 stalls in the last 24 h, longest 6.2 s",
      detail: "The libuv threadpool was slow 1 time in the last 24 h.",
    });
    expect(
      summarizeEventLoopHistory(
        history([stall()], { records: 1, stalls: 1, longestMs: 4_000, threadpoolStalls: 0 }),
        NOW,
      ).headline,
    ).toBe("1 stall in the last 24 h, longest 4.0 s");
  });

  it("points at the last stall when none happened in the last day", () => {
    const summary = summarizeEventLoopHistory(
      history([stall({ time: new Date(NOW - 3 * 86_400_000).toISOString() })], {
        records: 0,
        stalls: 0,
        longestMs: 0,
        threadpoolStalls: 0,
      }),
      NOW,
    );
    expect(summary).toEqual({
      state: "stalls",
      headline: "No event-loop stalls of 2 s or more in the last 24 h",
      detail: "The last one was recorded 3d ago.",
    });
  });

  it("takes the threadpool count from the server, not from the rows it sent", () => {
    // One first-of-window record plus one summary of 6: seven slow requests, two rows.
    const summary = summarizeEventLoopHistory(
      history([stall({ kind: "threadpool" }), stall({ kind: "threadpool", count: 6 })], {
        records: 2,
        stalls: 0,
        longestMs: 0,
        threadpoolStalls: 7,
      }),
      NOW,
    );
    expect(summary.detail).toBe("The libuv threadpool was slow 7 times in the last 24 h.");
  });
});

describe("stallHint", () => {
  it("reads CPU-bound, memory-pressure, kernel and waiting stalls from the evidence", () => {
    expect(stallHint(stall({ cpuUserMs: 3_500, cpuSystemMs: 100 }))).toBe(
      "CPU-bound (JavaScript or garbage collection)",
    );
    expect(stallHint(stall({ cpuUserMs: 3_500, majorPageFaults: 5_000 }))).toBe(
      "Memory pressure (page faults)",
    );
    // System time alone may be synchronous file-system calls, not memory pressure.
    expect(stallHint(stall({ cpuUserMs: 500, cpuSystemMs: 2_100 }))).toBe(
      "Kernel time (synchronous system calls or page faults)",
    );
    expect(stallHint(stall({ cpuSystemMs: 2_100, majorPageFaults: 1_500 }))).toBe(
      "Memory pressure (page faults)",
    );
    expect(stallHint(stall({ cpuUserMs: 200, cpuSystemMs: 100 }))).toBe(
      "Waiting (synchronous disk I/O or a lock)",
    );
    expect(stallHint(stall({ cpuUserMs: 2_000 }))).toBeUndefined();
    expect(stallHint(stall())).toBeUndefined();
  });

  it("explains threadpool stalls", () => {
    expect(stallHint(stall({ kind: "threadpool-pending" }))).toBe(
      "The libuv threadpool was saturated (file system, DNS or compression work queued)",
    );
  });
});

describe("stallRows", () => {
  it("labels rows, tags startup stalls and summarizes the evidence", () => {
    const [row] = stallRows(
      history([
        stall({
          count: 3,
          totalMs: 9_000,
          uptimeMs: 12_000,
          cpuUserMs: 3_000,
          cpuSystemMs: 200,
          majorPageFaults: 2,
          rssBytes: 512 * 1024 * 1024,
          loadAverage1m: 3.456,
          cpuCount: 10,
          suspendedMs: 1_500,
          busySource: "cpu",
          phases: ["persistence.migrations (3900 ms)"],
        }),
      ]),
      NOW,
    );
    expect(row).toMatchObject({
      label: "Event loop",
      relativeTime: "1m ago",
      duration: "4.0 s",
      countLabel: "3 stalls, 9.0 s in total",
      duringStartup: true,
      evidence:
        "CPU 3.2 s · 2 major page faults · RSS 512 MB · load 3.46 on 10 cores · 1.5 s asleep · measured by CPU time",
      phases: ["persistence.migrations (3900 ms)"],
    });
  });

  it("leaves out absent evidence and does not tag later stalls as startup", () => {
    const [row] = stallRows(history([stall({ kind: "gc-pause", uptimeMs: 600_000 })]), NOW);
    expect(row).toMatchObject({
      label: "gc-pause",
      countLabel: undefined,
      duringStartup: false,
      evidence: "",
      hint: undefined,
      phases: [],
    });
  });

  it("limits the rows", () => {
    const recent = Array.from({ length: 30 }, () => stall());
    expect(stallRows(history(recent), NOW)).toHaveLength(20);
    expect(stallRows(history(recent), NOW, 5)).toHaveLength(5);
    expect(stallRows(undefined, NOW)).toEqual([]);
  });
});
