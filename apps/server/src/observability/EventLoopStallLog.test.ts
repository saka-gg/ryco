import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { DiagnosticsEventLoopStall } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  encodeStallLine,
  EVENT_LOOP_STALL_LOG_FILE_NAME,
  eventLoopStallLogPath,
  eventLoopStallLogPaths,
  parseStallLine,
  parseStallLog,
  truncateStallPhase,
  type EventLoopStallLine,
} from "./EventLoopStallLog.ts";

const line: EventLoopStallLine = {
  time: "2026-10-23T08:00:30.000Z",
  kind: "event-loop",
  durationMs: 3_000,
  startedAt: "2026-10-23T08:00:10.000Z",
  count: 2,
  totalMs: 5_100,
  suspendedMs: 0,
  busySource: "elu",
  cpuUserMs: 2_950,
  cpuSystemMs: 40,
  majorPageFaults: 0,
  minorPageFaults: 1_200,
  involuntaryContextSwitches: 3,
  rssBytes: 300_000_000,
  heapUsedBytes: 120_000_000,
  loadAverage1m: 2.37,
  cpuCount: 10,
  phases: ["persistence.migrations (2900 ms)"],
  pid: 4242,
  uptimeMs: 45_000,
};

const decodeStall = Schema.decodeUnknownSync(DiagnosticsEventLoopStall);
// What the RPC layer does to the Diagnostics snapshot: stricter than decoding about trimming.
const encodeStall = Schema.encodeUnknownSync(DiagnosticsEventLoopStall);

describe("EventLoopStallLog", () => {
  it("places the log next to the trace file with one backup, oldest first", () => {
    const logPath = eventLoopStallLogPath("/home/u/.ryco/userdata/logs/server.trace.ndjson");
    expect(logPath).toBe(`/home/u/.ryco/userdata/logs/${EVENT_LOOP_STALL_LOG_FILE_NAME}`);
    expect(eventLoopStallLogPaths(logPath)).toEqual([`${logPath}.1`, logPath]);
  });

  it("round-trips a record through one line that the contract accepts", () => {
    const encoded = encodeStallLine(line);
    expect(encoded.includes("\n")).toBe(false);
    const parsed = parseStallLine(encoded);
    expect(parsed).toEqual(line);
    expect(decodeStall(parsed)).toEqual(line);
  });

  it("rounds fractional fields when writing", () => {
    const parsed = parseStallLine(
      encodeStallLine({ ...line, durationMs: 2_999.6, cpuUserMs: 10.4, loadAverage1m: 1.23456 }),
    );
    expect(parsed).toMatchObject({ durationMs: 3_000, cpuUserMs: 10, loadAverage1m: 1.23 });
  });

  it("accepts kinds it does not know and drops unknown fields", () => {
    const parsed = parseStallLine(
      JSON.stringify({ time: line.time, kind: "gc-pause", durationMs: 2_500, future: { x: 1 } }),
    );
    expect(parsed).toEqual({
      time: line.time,
      kind: "gc-pause",
      durationMs: 2_500,
      count: 1,
      totalMs: 2_500,
    });
  });

  it("rejects garbage, a missing time and a negative or non-finite duration", () => {
    expect(parseStallLine("not json")).toBeNull();
    expect(parseStallLine("[1,2]")).toBeNull();
    expect(parseStallLine(JSON.stringify({ kind: "event-loop", durationMs: 2_000 }))).toBeNull();
    expect(parseStallLine(JSON.stringify({ ...line, time: "yesterday" }))).toBeNull();
    expect(parseStallLine(JSON.stringify({ ...line, kind: "  " }))).toBeNull();
    expect(parseStallLine(JSON.stringify({ ...line, durationMs: -5 }))).toBeNull();
    expect(parseStallLine(JSON.stringify({ ...line, durationMs: "NaN" }))).toBeNull();
    expect(parseStallLine(JSON.stringify({ ...line, durationMs: null }))).toBeNull();
  });

  it("clamps optional fields so a hand-edited line cannot break the snapshot", () => {
    const parsed = parseStallLine(
      JSON.stringify({
        ...line,
        cpuUserMs: 12.7,
        cpuSystemMs: -4,
        majorPageFaults: "many",
        loadAverage1m: null,
        rssBytes: 1e300,
        phases: ["ok", 7, "", "x".repeat(400)],
        count: 0,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ cpuUserMs: 13, cpuSystemMs: 0, count: 1 });
    expect(parsed?.majorPageFaults).toBeUndefined();
    expect(parsed?.loadAverage1m).toBeUndefined();
    expect(parsed?.rssBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsed?.phases).toEqual(["ok", `${"x".repeat(159)}…`]);
    expect(() => decodeStall(parsed)).not.toThrow();
    expect(() => encodeStall(parsed)).not.toThrow();
  });

  it("trims strings again after cutting them, so the snapshot still encodes", () => {
    const parsed = parseStallLine(
      JSON.stringify({
        ...line,
        // Cut at 64 and 16 characters, right after a space.
        kind: `${"k".repeat(63)} tail`,
        busySource: `${"b".repeat(15)} tail`,
      }),
    );
    expect(parsed).toMatchObject({ kind: "k".repeat(63), busySource: "b".repeat(15) });
    expect(() => encodeStall(parsed)).not.toThrow();
  });

  it("cuts long phases with one rule for writer and reader", () => {
    expect(truncateStallPhase("short (5 ms)")).toBe("short (5 ms)");
    const cut = truncateStallPhase("p".repeat(400));
    expect(cut).toHaveLength(160);
    expect(cut.endsWith("…")).toBe(true);
    expect(truncateStallPhase(cut)).toBe(cut);
  });

  it("counts malformed lines but not a last line that is still being written", () => {
    const text = [
      encodeStallLine(line),
      "garbage",
      "",
      encodeStallLine({ ...line, count: 1 }),
      '{"time":"2026',
    ].join("\n");
    const parsed = parseStallLog(text);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.malformedLineCount).toBe(1);
    expect(parseStallLog(`${text}\n`).malformedLineCount).toBe(2);
  });

  it("keeps exactly one backup when the sink rotates", async () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-stall-log-"));
    try {
      const logPath = NodePath.join(tempDir, EVENT_LOOP_STALL_LOG_FILE_NAME);
      const sink = new AsyncRotatingFileSink({ filePath: logPath, maxBytes: 900, maxFiles: 1 });
      for (let index = 0; index < 12; index += 1) {
        await sink.write(`${encodeStallLine({ ...line, uptimeMs: index })}\n`);
      }
      await sink.close();
      expect(NodeFS.readdirSync(tempDir).toSorted()).toEqual([
        EVENT_LOOP_STALL_LOG_FILE_NAME,
        `${EVENT_LOOP_STALL_LOG_FILE_NAME}.1`,
      ]);
      const records = eventLoopStallLogPaths(logPath).flatMap(
        (filePath) => parseStallLog(NodeFS.readFileSync(filePath, "utf8")).records,
      );
      expect(records.at(-1)?.uptimeMs).toBe(11);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
