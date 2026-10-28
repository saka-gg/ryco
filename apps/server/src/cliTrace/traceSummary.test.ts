import { link, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { rotatedTraceFilePaths } from "../observability/TraceRecord.ts";
import { makeNamedPipe, settleBeforeNamedPipeDeadline } from "../testing/namedPipe.ts";
import {
  formatTraceSummary,
  makeTraceSpanSummary,
  nearestRankPercentile,
  readTraceFileLines,
  TRACE_SUMMARY_RETENTION_NOTE,
  traceSummaryJson,
} from "./traceSummary.ts";

const MINUTE_MS = 60_000;
const BASE_MS = Date.UTC(2026, 9, 24, 12, 0, 0);

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

const effectSpan = (
  name: string,
  durationMs: number,
  endMs: number,
  exit: "Success" | "Failure" | "Interrupted" = "Success",
) =>
  JSON.stringify({
    type: "effect-span",
    name,
    traceId: "t",
    spanId: "s",
    sampled: true,
    kind: "internal",
    startTimeUnixNano: nanos(endMs - durationMs),
    endTimeUnixNano: nanos(endMs),
    durationMs,
    attributes: {},
    events: [],
    links: [],
    exit: exit === "Success" ? { _tag: exit } : { _tag: exit, cause: "boom" },
  });

const otlpSpan = (
  name: string,
  durationMs: number,
  endMs: number,
  status: { readonly code?: string } | undefined,
  attributes: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "otlp-span",
    name,
    traceId: "t",
    spanId: "s",
    sampled: true,
    kind: "client",
    startTimeUnixNano: nanos(endMs - durationMs),
    endTimeUnixNano: nanos(endMs),
    durationMs,
    attributes,
    resourceAttributes: { "service.name": "ryco-web" },
    scope: { attributes: {} },
    events: [],
    links: [],
    ...(status === undefined ? {} : { status }),
  });

const tempDirs: Array<string> = [];
const makeTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryco-trace-summary-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("makeTraceSpanSummary", () => {
  it("drops spans that ended before --since and counts lines that are not spans", () => {
    const summary = makeTraceSpanSummary({ sinceMs: BASE_MS });
    summary.addLine(effectSpan("old.span", 5, BASE_MS - 1));
    summary.addLine(effectSpan("kept.span", 7, BASE_MS));
    summary.addLine("not json");
    summary.addLine(JSON.stringify({ name: "no.duration", endTimeUnixNano: nanos(BASE_MS) }));
    summary.addLine(JSON.stringify({ name: "bad.end", durationMs: 1, endTimeUnixNano: "soon" }));
    summary.addLine(
      JSON.stringify({ name: "past.date.range", durationMs: 1, endTimeUnixNano: "9".repeat(30) }),
    );
    summary.addLine("   ");
    // A last line a live server is still writing is neither counted nor skipped.
    summary.addLine('{"type":"effect-span","name":"half', false);

    const result = summary.finish();
    expect(result.spanCount).toBe(1);
    expect(result.skippedLineCount).toBe(4);
    expect(result.spans.map((span) => span.name)).toEqual(["kept.span"]);
  });

  it("maps effect-span exits and otlp-span status codes to failures and interrupts", () => {
    const summary = makeTraceSpanSummary();
    summary.addLine(effectSpan("server.op", 1, BASE_MS, "Success"));
    summary.addLine(effectSpan("server.op", 2, BASE_MS + 1, "Failure"));
    summary.addLine(effectSpan("server.op", 3, BASE_MS + 2, "Interrupted"));
    summary.addLine(otlpSpan("browser.op", 1, BASE_MS + 3, { code: "2" }));
    summary.addLine(otlpSpan("browser.op", 1, BASE_MS + 4, { code: "STATUS_CODE_ERROR" }));
    summary.addLine(otlpSpan("browser.op", 1, BASE_MS + 5, { code: "STATUS_CODE_OK" }));
    summary.addLine(
      otlpSpan("browser.op", 1, BASE_MS + 6, { code: "0" }, { "effect.fiber.interrupted": true }),
    );
    summary.addLine(otlpSpan("browser.op", 1, BASE_MS + 7, undefined));

    const byName = Object.fromEntries(
      summary.finish().spans.map((span) => [span.name, span] as const),
    );
    expect(byName["server.op"]).toMatchObject({ count: 3, failures: 1, interrupted: 1 });
    expect(byName["browser.op"]).toMatchObject({ count: 5, failures: 2, interrupted: 1 });
  });

  it("uses nearest-rank percentiles and leaves the rate out for a window with no length", () => {
    expect(nearestRankPercentile([1], 0.5)).toBe(1);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(nearestRankPercentile(hundred, 0.5)).toBe(50);
    expect(nearestRankPercentile(hundred, 0.9)).toBe(90);
    expect(nearestRankPercentile(hundred, 0.99)).toBe(99);
    expect(nearestRankPercentile([10, 20, 30], 0.5)).toBe(20);
    expect(nearestRankPercentile([10, 20, 30], 0.9)).toBe(30);

    const single = makeTraceSpanSummary();
    single.addLine(effectSpan("only", 4, BASE_MS));
    const singleResult = single.finish();
    expect(singleResult.minutes).toBe(0);
    expect(singleResult.spans[0]?.perMinute).toBeUndefined();

    const summary = makeTraceSpanSummary();
    // Durations 10..1 (shuffled by end time) over ten minutes.
    for (let index = 0; index < 10; index += 1) {
      summary.addLine(effectSpan("op", 10 - index, BASE_MS + (index * (10 * MINUTE_MS)) / 9));
    }
    const span = summary.finish().spans[0]!;
    expect(span).toMatchObject({ count: 10, p50Ms: 5, p90Ms: 9, p99Ms: 10, maxMs: 10 });
    expect(span.perMinute).toBeCloseTo(1, 10);
  });

  it("sorts busiest first, then by name", () => {
    const summary = makeTraceSpanSummary();
    summary.addLine(effectSpan("b", 1, BASE_MS));
    summary.addLine(effectSpan("a", 1, BASE_MS));
    summary.addLine(effectSpan("c", 1, BASE_MS));
    summary.addLine(effectSpan("c", 1, BASE_MS));
    expect(summary.finish().spans.map((span) => span.name)).toEqual(["c", "a", "b"]);
  });
});

describe("readTraceFileLines", () => {
  it("reads rotated files oldest first, skips missing ones and ones written before --since", async () => {
    const dir = await makeTempDir();
    const tracePath = join(dir, "server.trace.ndjson");
    await writeFile(`${tracePath}.3`, `${effectSpan("from.3", 1, BASE_MS)}\n`);
    // `.2` is missing.
    await writeFile(`${tracePath}.1`, `${effectSpan("from.1", 1, BASE_MS + 1)}\n`);
    await writeFile(tracePath, `${effectSpan("from.current", 1, BASE_MS + 2)}\n`);
    await writeFile(`${tracePath}.4`, `${effectSpan("from.4.old", 1, BASE_MS - 1)}\n`);
    const nowMs = Date.now();
    const old = new Date(nowMs - 10 * MINUTE_MS);
    await utimes(`${tracePath}.4`, old, old);

    const seen: Array<string> = [];
    const { filesRead } = await readTraceFileLines({
      paths: rotatedTraceFilePaths(tracePath, 4),
      sinceMs: nowMs - MINUTE_MS,
      onLine: (line) => seen.push(JSON.parse(line).name),
    });

    expect(filesRead).toEqual([`${tracePath}.3`, `${tracePath}.1`, tracePath]);
    expect(seen).toEqual(["from.3", "from.1", "from.current"]);
  });

  it("splits lines across read chunks and reports an unterminated last line", async () => {
    const dir = await makeTempDir();
    const tracePath = join(dir, "server.trace.ndjson");
    const long = effectSpan(`long.${"x".repeat(1_500_000)}`, 1, BASE_MS);
    await writeFile(tracePath, `${effectSpan("first", 1, BASE_MS)}\n${long}\n{"partial":`);

    const lines: Array<readonly [string, boolean]> = [];
    await readTraceFileLines({
      paths: [tracePath],
      onLine: (line, terminated) => lines.push([line, terminated]),
    });

    expect(lines.map(([line, terminated]) => [line.length, terminated])).toEqual([
      [effectSpan("first", 1, BASE_MS).length, true],
      [long.length, true],
      ['{"partial":'.length, false],
    ]);
  });

  it("keeps lines whole when a newline lands on either side of a read boundary", async () => {
    const dir = await makeTempDir();
    const tracePath = join(dir, "server.trace.ndjson");
    const chunk = 256 * 1024;
    // The first newline is the last byte of the first read, the second the first byte of a read.
    const first = "a".repeat(chunk - 1);
    const second = "b".repeat(chunk);
    await writeFile(tracePath, `${first}\n${second}\nc\n`);

    const lines: Array<string> = [];
    await readTraceFileLines({ paths: [tracePath], onLine: (line) => lines.push(line) });
    expect(lines.map((line) => line.length)).toEqual([chunk - 1, chunk, 1]);
    expect(lines[1]).toBe(second);
  });

  it.skipIf(process.platform === "win32")(
    "reports a FIFO named like a trace file without blocking, and still reads the rest",
    async () => {
      const dir = await makeTempDir();
      const tracePath = join(dir, "server.trace.ndjson");
      await writeFile(`${tracePath}.1`, `${effectSpan("from.1", 1, BASE_MS)}\n`);
      makeNamedPipe(tracePath);
      const seen: Array<string> = [];
      const result = await settleBeforeNamedPipeDeadline(tracePath, () =>
        readTraceFileLines({
          paths: rotatedTraceFilePaths(tracePath, 1),
          onLine: (line) => seen.push(JSON.parse(line).name),
        }),
      );
      expect(result).toEqual({
        filesRead: [`${tracePath}.1`],
        filesUnreadable: [{ path: tracePath, reason: "not a regular file" }],
      });
      expect(seen).toEqual(["from.1"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a final symbolic link only when asked",
    async () => {
      const dir = await makeTempDir();
      const target = join(dir, "real.ndjson");
      const link = join(dir, "server.trace.ndjson");
      await writeFile(target, `${effectSpan("linked", 1, BASE_MS)}\n`);
      await symlink(target, link);

      expect(await readTraceFileLines({ paths: [link], onLine: () => {} })).toEqual({
        filesRead: [],
        filesUnreadable: [{ path: link, reason: "not a regular file" }],
      });
      const seen: Array<string> = [];
      await readTraceFileLines({
        paths: [link],
        followSymlinks: true,
        onLine: (line) => seen.push(line),
      });
      expect(seen).toHaveLength(1);
    },
  );

  it("reads a file once when a rotation left it under two names while the set was opened", async () => {
    const dir = await makeTempDir();
    const tracePath = join(dir, "server.trace.ndjson");
    await writeFile(`${tracePath}.2`, `${effectSpan("from.2", 1, BASE_MS)}\n`);
    await writeFile(tracePath, `${effectSpan("from.current", 1, BASE_MS + 1)}\n`);
    // What the reader sees when the server renames the current file to `.1` right after the
    // reader opened it: the same file under its old and its new name.
    await link(tracePath, `${tracePath}.1`);

    const seen: Array<string> = [];
    const result = await readTraceFileLines({
      paths: rotatedTraceFilePaths(tracePath, 2),
      onLine: (line) => seen.push(JSON.parse(line).name),
    });
    expect(result).toEqual({ filesRead: [`${tracePath}.2`, tracePath], filesUnreadable: [] });
    expect(seen).toEqual(["from.2", "from.current"]);
  });
});

describe("formatTraceSummary", () => {
  const makeReport = (limit: number) => {
    const summary = makeTraceSpanSummary();
    summary.addLine(effectSpan("orchestration.dispatch", 12, BASE_MS));
    summary.addLine(
      effectSpan("orchestration.dispatch", 1_500, BASE_MS + 2 * MINUTE_MS, "Failure"),
    );
    summary.addLine(effectSpan("git.status", 40, BASE_MS + MINUTE_MS, "Interrupted"));
    summary.addLine("garbage");
    return {
      traceFilePath: "/home/u/.ryco/userdata/logs/server.trace.ndjson",
      filesRead: ["/home/u/.ryco/userdata/logs/server.trace.ndjson"],
      filesUnreadable: [],
      sinceMs: undefined,
      limit,
      summary: summary.finish(),
    };
  };

  it("prints a header, a padded table and the retention footnote", () => {
    expect(formatTraceSummary(makeReport(25))).toBe(
      [
        "3 spans ended from 2026-10-24T12:00:00.000Z to 2026-10-24T12:02:00.000Z (2.0 min), read from 1 file.",
        "Skipped 1 lines that are not spans.",
        "",
        "span                    count  /min   p50   p90   max  interrupted  failed",
        "orchestration.dispatch      2   1.0  12ms  1.5s  1.5s            0       1",
        "git.status                  1   0.5  40ms  40ms  40ms            1       0",
        "",
        TRACE_SUMMARY_RETENTION_NOTE,
      ].join("\n"),
    );
  });

  it("says how many span names --limit left out", () => {
    const text = formatTraceSummary(makeReport(1));
    expect(text).toContain("orchestration.dispatch");
    expect(text).not.toContain("git.status");
    expect(text).toContain("1 more span names. Use --limit to show more.");
  });

  it("names the file when nothing was found", () => {
    const empty = makeTraceSpanSummary().finish();
    expect(
      formatTraceSummary({
        traceFilePath: "/x/server.trace.ndjson",
        filesRead: [],
        filesUnreadable: [],
        sinceMs: BASE_MS,
        limit: 25,
        summary: empty,
      }),
    ).toBe("No spans found in /x/server.trace.ndjson or its rotated files in that window.");
  });

  it("names every file it could not read", () => {
    const filesUnreadable = [{ path: "/x/server.trace.ndjson.3", reason: "EACCES" }];
    expect(formatTraceSummary({ ...makeReport(25), filesUnreadable })).toContain(
      "Skipped 1 lines that are not spans.\nCould not read /x/server.trace.ndjson.3 (EACCES).\n",
    );
    expect(
      formatTraceSummary({
        traceFilePath: "/x/server.trace.ndjson",
        filesRead: [],
        filesUnreadable,
        sinceMs: undefined,
        limit: 25,
        summary: makeTraceSpanSummary().finish(),
      }),
    ).toBe(
      "No spans found in /x/server.trace.ndjson or its rotated files.\nCould not read /x/server.trace.ndjson.3 (EACCES).",
    );
  });

  it("shows control characters in span names as escapes and cuts long names", () => {
    // Browser span names come from any authenticated session; none may drive the terminal.
    const hostile = "\u001b]52;c;ZWNobyBwd25lZA==\u0007\u001b[2J\u001b[Hspan.fake\u009b31m\u007f";
    const long = `span.long.${"x".repeat(1024 * 1024)}`;
    const summary = makeTraceSpanSummary();
    summary.addLine(effectSpan(hostile, 5, BASE_MS));
    summary.addLine(effectSpan(long, 7, BASE_MS + MINUTE_MS));
    const text = formatTraceSummary({
      traceFilePath: "/x/server.trace.ndjson",
      filesRead: ["/x/server.trace.ndjson"],
      filesUnreadable: [],
      sinceMs: undefined,
      limit: 25,
      summary: summary.finish(),
    });
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(text).toContain(
      "\\u001b]52;c;ZWNobyBwd25lZA==\\u0007\\u001b[2J\\u001b[Hspan.fake\\u009b31m\\u007f",
    );
    const longRow = text.split("\n").find((line) => line.startsWith("span.long."));
    expect(longRow).toMatch(/^span\.long\.x+… {2}/u);
    expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThan(250);
    // --json keeps the names as they are; JSON escapes control characters itself.
    expect(traceSummaryJson({ ...makeReport(25), summary: summary.finish() }).spans).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: hostile })]),
    );
  });

  it("emits the --json document with every span field", () => {
    const json = traceSummaryJson(makeReport(1));
    expect(json).toEqual({
      traceFilePath: "/home/u/.ryco/userdata/logs/server.trace.ndjson",
      filesRead: ["/home/u/.ryco/userdata/logs/server.trace.ndjson"],
      filesUnreadable: [],
      spanCount: 3,
      skippedLineCount: 1,
      firstEndAt: "2026-10-24T12:00:00.000Z",
      lastEndAt: "2026-10-24T12:02:00.000Z",
      minutes: 2,
      spanNameCount: 2,
      spans: [
        {
          name: "orchestration.dispatch",
          count: 2,
          perMinute: 1,
          p50Ms: 12,
          p90Ms: 1_500,
          p99Ms: 1_500,
          maxMs: 1_500,
          interrupted: 0,
          failures: 1,
        },
      ],
    });
  });
});
