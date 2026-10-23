import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, Tracer } from "effect";
import { TestClock } from "effect/testing";

import {
  makeThreadpoolCanary,
  trackStartupPhase,
  type ThreadpoolCanary,
  type ThreadpoolCanaryProbe,
} from "../startupStallMonitor.ts";
import {
  classifyGap,
  makeDefaultEventLoopSamplerDeps,
  makeEventLoopMonitor,
  makeEventLoopSampler,
  makeStallWindow,
  THREADPOOL_CANARY_INTERVAL_MS,
  type EventLoopSamplerDeps,
  type LoopTickReading,
  type StallEvidence,
} from "./EventLoopMonitor.ts";
import {
  EVENT_LOOP_STALL_LOG_FILE_NAME,
  parseStallLog,
  type EventLoopStallLine,
} from "./EventLoopStallLog.ts";

const WALL_ZERO = Date.parse("2026-10-23T08:00:00.000Z");

/** A reading `monotonicMs` after start, with cumulative ELU active time and CPU time (ms). */
const reading = (
  monotonicMs: number,
  eluActiveMs: number,
  options: {
    readonly cpuMs?: number;
    readonly majorPageFault?: number;
    readonly elu?: boolean;
  } = {},
): LoopTickReading => ({
  monotonicMs,
  wallMs: WALL_ZERO + monotonicMs,
  eluIdleMs: options.elu === false ? 0 : Math.max(1, monotonicMs - eluActiveMs),
  eluActiveMs: options.elu === false ? 0 : eluActiveMs,
  usage: {
    userCPUTime: (options.cpuMs ?? eluActiveMs) * 1_000,
    systemCPUTime: 0,
    majorPageFault: options.majorPageFault ?? 0,
    minorPageFault: 0,
    involuntaryContextSwitches: 0,
  },
});

const idleCanary = (): ThreadpoolCanary => ({
  probe: () => ({ settled: [], pending: null }),
  markPendingReported: () => undefined,
});

/** A canary whose probes return the scripted results in order, then nothing. */
const scriptedCanary = (probes: Array<ThreadpoolCanaryProbe>): ThreadpoolCanary => {
  let reported = false;
  return {
    probe: () => {
      const next = probes.shift() ?? { settled: [], pending: null };
      return next.pending === null
        ? next
        : { ...next, pending: { ...next.pending, reported: next.pending.reported || reported } };
    },
    markPendingReported: () => {
      reported = true;
    },
  };
};

const samplerDeps = (
  readings: Array<LoopTickReading>,
  overrides: Partial<EventLoopSamplerDeps> = {},
): EventLoopSamplerDeps => {
  let last = readings[0]!;
  return {
    read: () => {
      last = readings.shift() ?? last;
      return last;
    },
    canary: idleCanary(),
    memory: () => ({ rssBytes: 200 * 1024 * 1024, heapUsedBytes: 80 * 1024 * 1024 }),
    loadAverage1m: () => 1.5,
    uptimeMs: () => 120_000,
    phases: () => [],
    pid: 4242,
    cpuCount: 8,
    ...overrides,
  };
};

const evidence = (durationMs: number, overrides: Partial<StallEvidence> = {}): StallEvidence => ({
  kind: "event-loop",
  durationMs,
  startedAtWallMs: WALL_ZERO,
  detectedAtWallMs: WALL_ZERO + durationMs,
  suspendedMs: 0,
  busySource: "elu",
  usage: {
    cpuUserMs: durationMs,
    cpuSystemMs: 0,
    majorPageFaults: 0,
    minorPageFaults: 0,
    involuntaryContextSwitches: 0,
  },
  rssBytes: 1,
  heapUsedBytes: 1,
  loadAverage1m: undefined,
  phases: [],
  uptimeMs: 1_000,
  ...overrides,
});

const messageText = (message: unknown) => String(Array.isArray(message) ? message[0] : message);

const captureLogs = (messages: Array<string>) =>
  Logger.layer(
    [
      Logger.make((options) => {
        messages.push(messageText(options.message));
      }),
    ],
    { mergeWithExisting: false },
  );

describe("classifyGap", () => {
  it("measures a busy gap by its busy time and starts it at the previous tick", () => {
    const verdict = classifyGap(reading(10_000, 100), reading(13_500, 3_100));
    expect(verdict).toMatchObject({
      kind: "stall",
      durationMs: 3_000,
      gapMs: 3_500,
      suspendedMs: 0,
      busySource: "elu",
      startedAtWallMs: WALL_ZERO + 10_000,
    });
  });

  it("treats machine sleep as a suspension, never a stall", () => {
    expect(classifyGap(reading(10_000, 100), reading(610_000, 1_000))).toEqual({
      kind: "suspended",
      gapMs: 600_000,
      busyMs: 900,
      busySource: "elu",
    });
  });

  it("records the busy part of a gap that was partly asleep", () => {
    const verdict = classifyGap(reading(10_000, 100), reading(610_000, 4_100));
    expect(verdict).toMatchObject({ kind: "stall", durationMs: 4_000, suspendedMs: 595_000 });
  });

  it("ignores gaps below the threshold", () => {
    expect(classifyGap(reading(10_000, 100), reading(11_900, 1_900))).toEqual({ kind: "none" });
    // Late by 1.8 s, of which 1.5 s busy: neither a stall nor a suspension.
    expect(classifyGap(reading(10_000, 100), reading(12_800, 1_600))).toEqual({ kind: "none" });
  });

  it("records a 2.2 s block that began just before a tick was due (late by only 1.9 s)", () => {
    const verdict = classifyGap(reading(10_000, 100), reading(12_900, 2_300));
    expect(verdict).toMatchObject({ kind: "stall", durationMs: 2_200 });
  });

  it("falls back to CPU time where the runtime reports no event-loop utilization (Bun)", () => {
    const stall = classifyGap(
      reading(10_000, 0, { elu: false, cpuMs: 100 }),
      reading(13_500, 0, { elu: false, cpuMs: 2_600 }),
    );
    expect(stall).toMatchObject({ kind: "stall", durationMs: 2_500, busySource: "cpu" });
    const asleep = classifyGap(
      reading(10_000, 0, { elu: false, cpuMs: 100 }),
      reading(40_000, 0, { elu: false, cpuMs: 150 }),
    );
    expect(asleep).toMatchObject({ kind: "suspended", busySource: "cpu" });
  });

  it("reports CPU and page-fault evidence over the gap", () => {
    const verdict = classifyGap(
      reading(10_000, 100, { cpuMs: 50, majorPageFault: 10 }),
      reading(14_000, 3_100, { cpuMs: 650, majorPageFault: 2_510 }),
    );
    expect(verdict).toMatchObject({
      kind: "stall",
      usage: { cpuUserMs: 600, majorPageFaults: 2_500 },
    });
  });
});

describe("makeStallWindow", () => {
  it("writes the first stall at once and folds the rest into one record at close", () => {
    const window = makeStallWindow({ pid: 7, cpuCount: 4 });
    const first = window.add(evidence(2_100));
    expect(first).toMatchObject({
      kind: "event-loop",
      durationMs: 2_100,
      count: 1,
      totalMs: 2_100,
    });
    expect(window.add(evidence(6_000, { rssBytes: 66 }))).toBeNull();
    expect(window.add(evidence(3_000))).toBeNull();

    const closed = window.close(WALL_ZERO + 30_000);
    expect(closed.longestStallMs).toBe(6_000);
    expect(closed.lines).toHaveLength(1);
    expect(closed.lines[0]).toMatchObject({
      kind: "event-loop",
      durationMs: 6_000,
      count: 2,
      totalMs: 9_000,
      rssBytes: 66,
      pid: 7,
      cpuCount: 4,
      time: new Date(WALL_ZERO + 30_000).toISOString(),
    });
    // Together the two records count every stall once.
    expect((first?.count ?? 0) + (closed.lines[0]?.count ?? 0)).toBe(3);
    expect((first?.totalMs ?? 0) + (closed.lines[0]?.totalMs ?? 0)).toBe(11_100);
  });

  it("yields nothing for an empty window and starts over after a close", () => {
    const window = makeStallWindow({ pid: 7, cpuCount: 4 });
    expect(window.close(WALL_ZERO).lines).toEqual([]);
    expect(window.add(evidence(2_500))).not.toBeNull();
    window.close(WALL_ZERO);
    expect(window.add(evidence(2_500))).not.toBeNull();
  });
});

describe("makeEventLoopSampler", () => {
  it("drops a threadpool canary that spanned a machine sleep", () => {
    const sampler = makeEventLoopSampler(
      samplerDeps([reading(0, 0), reading(1_000, 10), reading(601_000, 900)], {
        canary: scriptedCanary([
          { settled: [], pending: null },
          {
            settled: [{ startedAtMs: 900, settledAtMs: 600_950, reportedPending: false }],
            pending: null,
          },
        ]),
      }),
    );
    expect(sampler.tick()).toEqual([]);
    expect(sampler.tick()).toEqual([]);
    const summary = sampler.closeWindow();
    expect(summary.lines).toEqual([]);
    expect(summary.suspendedGapCount).toBe(1);
    expect(summary.longestSuspendedGapMs).toBe(600_000);
  });

  it("drops a threadpool canary held up by an event-loop stall", () => {
    const sampler = makeEventLoopSampler(
      samplerDeps(
        [reading(0, 0), reading(1_000, 10), reading(5_000, 3_510), reading(6_000, 3_520)],
        {
          canary: scriptedCanary([
            { settled: [], pending: null },
            { settled: [], pending: null },
            // Issued just before a 3.5 s stall; its callback could only run after it.
            {
              settled: [{ startedAtMs: 1_000, settledAtMs: 5_001, reportedPending: false }],
              pending: null,
            },
          ]),
        },
      ),
    );
    expect(sampler.tick()).toEqual([]);
    expect(sampler.tick().map((line) => line.kind)).toEqual(["event-loop"]);
    expect(sampler.tick()).toEqual([]);
  });

  it("records a slow threadpool canary on a free loop", () => {
    const sampler = makeEventLoopSampler(
      samplerDeps(
        [0, 1_000, 2_000, 3_000, 4_000].map((atMs) => reading(atMs, atMs / 100)),
        {
          canary: scriptedCanary([
            { settled: [], pending: null },
            { settled: [], pending: null },
            { settled: [], pending: null },
            {
              settled: [{ startedAtMs: 1_200, settledAtMs: 3_700, reportedPending: false }],
              pending: null,
            },
          ]),
        },
      ),
    );
    expect([sampler.tick(), sampler.tick(), sampler.tick()].flat()).toEqual([]);
    const lines = sampler.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "threadpool", durationMs: 2_500, count: 1 });
  });

  it("drops a canary held up by a long gap that was neither a stall nor a suspension", () => {
    const sampler = makeEventLoopSampler(
      samplerDeps(
        // 3 s gap: 1.5 s busy and 1.5 s idle beyond the tick, so below both thresholds.
        [reading(0, 0), reading(1_000, 10), reading(4_000, 1_510)],
        {
          canary: scriptedCanary([
            { settled: [], pending: null },
            {
              settled: [{ startedAtMs: 1_000, settledAtMs: 3_990, reportedPending: false }],
              pending: null,
            },
          ]),
        },
      ),
    );
    expect(sampler.tick()).toEqual([]);
    expect(sampler.tick()).toEqual([]);
    expect(sampler.closeWindow().lines).toEqual([]);
  });

  it("records a canary once when it settles after being reported as pending", () => {
    const pending = { startedAtMs: 1_000, reported: false };
    const sampler = makeEventLoopSampler(
      samplerDeps(
        Array.from({ length: 12 }, (_, index) => reading(index * 1_000, index * 10)),
        {
          canary: scriptedCanary([
            { settled: [], pending: null },
            ...Array.from({ length: 8 }, () => ({ settled: [], pending })),
            {
              settled: [{ startedAtMs: 1_000, settledAtMs: 9_500, reportedPending: true }],
              pending: null,
            },
          ]),
        },
      ),
    );
    const written = [];
    for (let tick = 1; tick < 12; tick += 1) written.push(...sampler.tick());
    expect(written.map((line) => [line.kind, line.durationMs])).toEqual([
      ["threadpool-pending", 2_000],
    ]);
    expect(sampler.closeWindow().lines).toEqual([]);
  });

  it("reports a canary pending across two windows exactly once", () => {
    const pending = { startedAtMs: 1_000, reported: false };
    const readings = Array.from({ length: 70 }, (_, index) => reading(index * 1_000, index * 10));
    const sampler = makeEventLoopSampler(
      samplerDeps(readings, {
        canary: scriptedCanary(Array.from({ length: 70 }, () => ({ settled: [], pending }))),
      }),
    );
    const written = [];
    for (let tick = 1; tick < 35; tick += 1) written.push(...sampler.tick());
    const firstWindow = sampler.closeWindow();
    for (let tick = 35; tick < 66; tick += 1) written.push(...sampler.tick());
    const secondWindow = sampler.closeWindow();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: "threadpool-pending", durationMs: 2_000 });
    expect([...firstWindow.lines, ...secondWindow.lines]).toEqual([]);
  });

  it("captures phases and memory at the stall, not at window close", () => {
    const intervals: Array<[number, number]> = [];
    let rssBytes = 100;
    const sampler = makeEventLoopSampler(
      samplerDeps([reading(0, 0), reading(1_000, 10), reading(4_000, 2_900)], {
        memory: () => ({ rssBytes, heapUsedBytes: 50 }),
        phases: (start, end) => {
          intervals.push([start, end]);
          return ["culprit.block (2800 ms)"];
        },
      }),
    );
    sampler.tick();
    const [line] = sampler.tick();
    rssBytes = 999;
    expect(intervals).toEqual([[WALL_ZERO + 1_000, WALL_ZERO + 4_000]]);
    expect(line).toMatchObject({ rssBytes: 100, phases: ["culprit.block (2800 ms)"] });
    expect(sampler.closeWindow().lines).toEqual([]);
  });

  it("reports the window's event-loop utilization", () => {
    const sampler = makeEventLoopSampler(samplerDeps([reading(0, 0), reading(30_000, 7_500)]));
    expect(sampler.closeWindow().utilization).toBeCloseTo(0.25, 3);
  });
});

describe("threadpool canary cadence", () => {
  it("issues a canary at most every 5 s but checks a pending one at every probe", () => {
    let nowMs = 0;
    const callbacks: Array<() => void> = [];
    const canary = makeThreadpoolCanary({
      now: () => nowMs,
      minIssueIntervalMs: THREADPOOL_CANARY_INTERVAL_MS,
      stat: (_directory, callback) => {
        callbacks.push(callback);
      },
    });
    const probeAt = (atMs: number) => {
      nowMs = atMs;
      return canary.probe();
    };
    expect(probeAt(0)).toEqual({ settled: [], pending: null });
    expect(callbacks).toHaveLength(1);
    nowMs = 3;
    callbacks[0]!();
    expect(probeAt(1_000)).toEqual({
      settled: [{ startedAtMs: 0, settledAtMs: 3, reportedPending: false }],
      pending: null,
    });
    for (const atMs of [2_000, 3_000, 4_000]) probeAt(atMs);
    expect(callbacks).toHaveLength(1);
    probeAt(5_000);
    expect(callbacks).toHaveLength(2);
    // Hung: reported from every later probe, and no second canary is issued meanwhile.
    expect(probeAt(6_000).pending).toEqual({ startedAtMs: 5_000, reported: false });
    expect(probeAt(12_000).pending).toEqual({ startedAtMs: 5_000, reported: false });
    expect(callbacks).toHaveLength(2);
    // A canary reported while pending says so when it finally settles.
    canary.markPendingReported();
    expect(probeAt(13_000).pending).toEqual({ startedAtMs: 5_000, reported: true });
    nowMs = 13_500;
    callbacks[1]!();
    expect(probeAt(14_000).settled).toEqual([
      { startedAtMs: 5_000, settledAtMs: 13_500, reportedPending: true },
    ]);
  });

  it("issues a new canary as soon as the last settled without an interval (startup monitor)", () => {
    const callbacks: Array<() => void> = [];
    const canary = makeThreadpoolCanary({
      now: () => 0,
      stat: (_directory, callback) => {
        callbacks.push(callback);
      },
    });
    canary.probe();
    callbacks[0]!();
    canary.probe();
    expect(callbacks).toHaveLength(2);
  });
});

describe("stall phase attribution", () => {
  it.effect("lists the phase behind a stall and leaves out phases before and after it", () =>
    Effect.gen(function* () {
      const id = crypto.randomUUID();
      const busy = (ms: number) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < ms) {
          // Busy-wait: each phase must cover a real wall-clock interval.
        }
      };
      yield* trackStartupPhase(
        `test.before.${id}`,
        Effect.sync(() => busy(5)),
      );
      busy(5);
      const stallStart = Date.now();
      yield* trackStartupPhase(
        `test.culprit.${id}`,
        Effect.sync(() => busy(30)),
      );
      const stallEnd = Date.now();
      busy(5);
      yield* trackStartupPhase(
        `test.after.${id}`,
        Effect.sync(() => busy(5)),
      );
      const phases = makeDefaultEventLoopSamplerDeps().phases(stallStart, stallEnd);
      expect(phases.some((phase) => phase.startsWith(`test.culprit.${id}`))).toBe(true);
      expect(phases.some((phase) => phase.startsWith(`test.before.${id}`))).toBe(false);
      expect(phases.some((phase) => phase.startsWith(`test.after.${id}`))).toBe(false);
    }),
  );

  it.effect("keeps the culprit ahead of long-running phases and caps the list at 8", () =>
    Effect.gen(function* () {
      const id = crypto.randomUUID();
      const busy = (ms: number) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < ms) {
          // Busy-wait.
        }
      };
      const background = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, index) => index),
        (index) =>
          trackStartupPhase(`test.inflight.${id}.${index}`, Effect.never).pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      busy(2);
      const stallStart = Date.now();
      yield* trackStartupPhase(
        `test.culprit.${id}`,
        Effect.sync(() => busy(20)),
      );
      const stallEnd = Date.now();
      const phases = makeDefaultEventLoopSamplerDeps().phases(stallStart, stallEnd);
      expect(phases).toHaveLength(8);
      expect(phases[0]?.startsWith(`test.culprit.${id}`)).toBe(true);
      yield* Fiber.interruptAll(background);
    }),
  );
});

const readLines = (filePath: string) =>
  NodeFS.existsSync(filePath) ? parseStallLog(NodeFS.readFileSync(filePath, "utf8")).records : [];

const captureSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
};

/** Waits on real time: the sink writes through the real file system. */
const waitForReal = (condition: () => boolean, timeoutMs = 5_000) =>
  Effect.promise(async () => {
    const startedAt = Date.now();
    while (!condition()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

describe("makeEventLoopMonitor", () => {
  it.effect("writes a stall at once, the rest at window close, as root Warn spans", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-elm-"));
      const logPath = NodePath.join(tempDir, "logs", EVENT_LOOP_STALL_LOG_FILE_NAME);
      const { spans, layer } = captureSpans();
      const messages: Array<string> = [];
      let onTick: (() => void) | undefined;
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* makeEventLoopMonitor({
              logPath,
              sampler: samplerDeps([
                reading(0, 0),
                reading(4_000, 3_000),
                reading(10_000, 8_000),
                reading(30_000, 8_200),
              ]),
              startTicker: (tick) => {
                onTick = tick;
                return () => {
                  onTick = undefined;
                };
              },
            });
            onTick?.();
            yield* waitForReal(() => readLines(logPath).length === 1);
            expect(readLines(logPath)[0]).toMatchObject({
              kind: "event-loop",
              durationMs: 3_000,
              count: 1,
              pid: 4242,
              cpuCount: 8,
            });
            onTick?.();
            expect(readLines(logPath)).toHaveLength(1);
            yield* TestClock.adjust(30_000);
            yield* waitForReal(() => readLines(logPath).length === 2);
            expect(readLines(logPath)[1]).toMatchObject({ durationMs: 5_000, count: 1 });
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              layer,
              Layer.succeed(Tracer.MinimumTraceLevel, "Warn"),
              captureLogs(messages),
            ),
          ),
        );
        expect(onTick).toBeUndefined();
        yield* waitForReal(
          () =>
            spans.filter(
              (span) => span.name === "server.eventLoop.stall" && span.status._tag === "Ended",
            ).length === 2,
        );
        for (const span of spans.filter((entry) => entry.name === "server.eventLoop.stall")) {
          expect(span.parent._tag).toBe("None");
          // Sampled under a Warn minimum trace level only because the span is at Warn.
          expect(span.sampled).toBe(true);
        }
        expect(messages).toContain("event loop stalled for 3000 ms");
        expect(messages).toContain("event loop stalled for 5000 ms");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes the open window's stalls when the server shuts down", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-elm-"));
      const logPath = NodePath.join(tempDir, EVENT_LOOP_STALL_LOG_FILE_NAME);
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            let onTick: (() => void) | undefined;
            yield* makeEventLoopMonitor({
              logPath,
              sampler: samplerDeps([
                reading(0, 0),
                reading(4_000, 3_000),
                reading(8_000, 6_500),
                reading(9_000, 6_510),
              ]),
              startTicker: (tick) => {
                onTick = tick;
                return () => undefined;
              },
            });
            onTick?.();
            onTick?.();
            // The scope closes 9 s into the window, long before it would close on its own.
          }),
        ).pipe(Effect.provide(captureLogs([])));
        expect(readLines(logPath).map((line) => [line.durationMs, line.count])).toEqual([
          [3_000, 1],
          [3_500, 1],
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("reports a stall log it cannot write without failing the monitor", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-elm-"));
      // A file where the log's directory should be: initialization and every write fail.
      NodeFS.writeFileSync(NodePath.join(tempDir, "logs"), "");
      const logPath = NodePath.join(tempDir, "logs", EVENT_LOOP_STALL_LOG_FILE_NAME);
      const messages: Array<string> = [];
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            let onTick: (() => void) | undefined;
            yield* makeEventLoopMonitor({
              logPath,
              sampler: samplerDeps([reading(0, 0), reading(4_000, 3_000)]),
              startTicker: (tick) => {
                onTick = tick;
                return () => undefined;
              },
            });
            onTick?.();
            yield* waitForReal(() =>
              messages.some((message) => message.startsWith("Could not write the event-loop")),
            );
          }),
        ).pipe(Effect.provide(captureLogs(messages)));
        yield* waitForReal(() => messages.includes("event loop stalled for 3000 ms"));
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("makeEventLoopMonitor failures", () => {
  it.effect("stays off, without failing the server, when it cannot take a first reading", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-elm-"));
      const logPath = NodePath.join(tempDir, EVENT_LOOP_STALL_LOG_FILE_NAME);
      const messages: Array<string> = [];
      let tickerStarted = false;
      try {
        yield* Effect.scoped(
          makeEventLoopMonitor({
            logPath,
            sampler: samplerDeps([reading(0, 0)], {
              read: () => {
                throw new Error("resource usage unavailable");
              },
            }),
            startTicker: () => {
              tickerStarted = true;
              return () => undefined;
            },
          }),
        ).pipe(Effect.provide(captureLogs(messages)));
        expect(messages).toContain(
          "The event-loop monitor could not start; stalls are not recorded",
        );
        expect(tickerStarted).toBe(false);
        expect(NodeFS.existsSync(logPath)).toBe(false);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps running and still closes the log when a window-close reading fails", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-elm-"));
      const logPath = NodePath.join(tempDir, EVENT_LOOP_STALL_LOG_FILE_NAME);
      const messages: Array<string> = [];
      const readings = [reading(0, 0), reading(4_000, 3_000)];
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            let onTick: (() => void) | undefined;
            yield* makeEventLoopMonitor({
              logPath,
              sampler: samplerDeps([reading(0, 0)], {
                read: () => {
                  const next = readings.shift();
                  if (next === undefined) throw new Error("resource usage unavailable");
                  return next;
                },
              }),
              startTicker: (tick) => {
                onTick = tick;
                return () => undefined;
              },
            });
            onTick?.();
            yield* TestClock.adjust(30_000);
            expect(messages).toContain("The event-loop monitor could not take a reading");
          }),
        ).pipe(Effect.provide(captureLogs(messages)));
        // The finalizer's own window close failed too, yet the log was flushed and closed.
        expect(readLines(logPath).map((line) => line.durationMs)).toEqual([3_000]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("live sampler", () => {
  // Real clocks, ELU and phases: a 900 ms block in a timer callback must reach a record that
  // names its phase. Listed in test/timingTests.ts (real timers under load).
  it.live("sees a real busy-wait and the phase that caused it", () =>
    Effect.promise(async () => {
      const phase = `test.live.block.${crypto.randomUUID()}`;
      const sampler = makeEventLoopSampler({
        ...makeDefaultEventLoopSamplerDeps(),
        canary: idleCanary(),
        tickMs: 100,
        thresholdMs: 400,
      });
      const lines: Array<EventLoopStallLine> = [];
      const ticker = setInterval(() => lines.push(...sampler.tick()), 100);
      const blocker = setTimeout(() => {
        Effect.runSync(
          trackStartupPhase(
            phase,
            Effect.sync(() => {
              const startedAt = performance.now();
              while (performance.now() - startedAt < 900) {
                // Block the event loop.
              }
            }),
          ),
        );
      }, 150);
      const startedAt = Date.now();
      const matches = (line: (typeof lines)[number]) =>
        line.phases?.some((name) => name.startsWith(phase)) === true;
      try {
        while (!lines.some(matches)) {
          if (Date.now() - startedAt > 10_000) throw new Error("no stall recorded");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        clearInterval(ticker);
        clearTimeout(blocker);
      }
      expect(lines.find(matches)?.durationMs).toBeGreaterThanOrEqual(850);
    }),
  );
});
