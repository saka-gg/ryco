/**
 * Lifetime event-loop stall monitor.
 *
 * The startup monitor (`startupStallMonitor.ts`) watches only the first 30 s. This one runs for the
 * whole life of the server and records every event-loop stall of 2 s or more, with the evidence
 * needed to tell what kind of stall it was, without counting machine sleep or a stopped process.
 *
 * Mechanism: a plain 1 Hz `setInterval` (unref'd, no fiber) measures the gap between its own
 * callbacks. A gap far longer than the tick means the loop could not run timers. The busy time
 * inside that gap, from the cumulative event-loop utilization (ELU), separates a blocked loop
 * (busy: JavaScript, garbage collection or synchronous I/O) from a suspended one (idle: machine
 * sleep, SIGSTOP, a paused VM). Bun reports no ELU, so there the process CPU time inside the gap
 * stands in for it (sync I/O stalls are then undercounted). Unlike resetting a native delay
 * histogram on a timer, the gap test has no blind spot after each sample.
 *
 * A libuv threadpool canary (one `fs.stat` at most every 5 s, one in flight at a time) runs
 * alongside; its latency counts only when no long loop gap overlapped it, since a blocked or
 * suspended loop delays the callback too. A canary is recorded once: one already recorded as
 * pending is not recorded again when it settles.
 *
 * Records are bounded per 30 s window: the first stall of each kind is written at once (so a crash
 * or restart right after it cannot lose it), later ones in the same window fold into one summary
 * record written when the window closes or the server shuts down. Each record goes to
 * `event-loop-stalls.ndjson` next to the trace file, to a root Warn span (which survives
 * `RYCO_TRACE_MIN_LEVEL=Warn` and the short-span filter) carrying the warning log, and to the
 * stall counter.
 *
 * @module EventLoopMonitor
 */
import * as NodeOS from "node:os";
import { performance } from "node:perf_hooks";

import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { Effect, Layer, Metric, type Scope } from "effect";

import { ServerConfig } from "../config.ts";
import { logOnceEvery } from "../logOnceEvery.ts";
import {
  describeStartupPhasesInInterval,
  makeThreadpoolCanary,
  type ThreadpoolCanary,
} from "../startupStallMonitor.ts";
import {
  encodeStallLine,
  EVENT_LOOP_STALL_LOG_MAX_BYTES,
  EVENT_LOOP_STALL_LOG_MAX_FILES,
  EVENT_LOOP_STALL_PHASE_LIMIT,
  eventLoopStallLogPath,
  truncateStallPhase,
  type EventLoopStallLine,
} from "./EventLoopStallLog.ts";
import {
  increment,
  serverEventLoopStallMaxMs,
  serverEventLoopStallsTotal,
  serverEventLoopUtilization,
} from "./Metrics.ts";

export const EVENT_LOOP_TICK_MS = 1_000;
export const EVENT_LOOP_WINDOW_MS = 30_000;
export const EVENT_LOOP_STALL_THRESHOLD_MS = 2_000;
export const THREADPOOL_STALL_THRESHOLD_MS = 2_000;
/**
 * Least time between two threadpool canaries. Issuing one costs a threadpool round trip and an
 * extra loop wakeup, more than the tick itself. With 1 s ticks canaries start at most 6 s apart,
 * so any saturation of 8 s or more is caught; a pending canary is still checked at every tick.
 */
export const THREADPOOL_CANARY_INTERVAL_MS = 5_000;
export const STALL_PHASE_LIMIT = EVENT_LOOP_STALL_PHASE_LIMIT;
/** Loop gaps remembered for discounting threadpool canaries that overlapped one. */
const LOOP_GAP_HISTORY_LIMIT = 16;

export type EventLoopStallKind = "event-loop" | "threadpool" | "threadpool-pending";
export type EventLoopBusySource = "elu" | "cpu";

/** Cumulative counters from `process.resourceUsage()`; CPU times in microseconds. */
export interface LoopUsage {
  readonly userCPUTime: number;
  readonly systemCPUTime: number;
  readonly majorPageFault: number;
  readonly minorPageFault: number;
  readonly involuntaryContextSwitches: number;
}

/** Taken at every tick: a handful of clock and counter reads, no allocation beyond the object. */
export interface LoopTickReading {
  /** `performance.now()`; keeps running across machine sleep on macOS and Windows. */
  readonly monotonicMs: number;
  readonly wallMs: number;
  /** Cumulative event-loop utilization. Both are 0 where the runtime does not implement it (Bun). */
  readonly eluIdleMs: number;
  readonly eluActiveMs: number;
  readonly usage: LoopUsage;
}

export const readLoopTick = (): LoopTickReading => {
  const elu = performance.eventLoopUtilization();
  const usage = process.resourceUsage();
  return {
    monotonicMs: performance.now(),
    wallMs: Date.now(),
    eluIdleMs: elu.idle,
    eluActiveMs: elu.active,
    usage: {
      userCPUTime: usage.userCPUTime,
      systemCPUTime: usage.systemCPUTime,
      majorPageFault: usage.majorPageFault,
      minorPageFault: usage.minorPageFault,
      involuntaryContextSwitches: usage.involuntaryContextSwitches,
    },
  };
};

export interface StallUsageDelta {
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly majorPageFaults: number;
  readonly minorPageFaults: number;
  readonly involuntaryContextSwitches: number;
}

export type GapVerdict =
  | { readonly kind: "none" }
  | {
      readonly kind: "stall";
      /** Busy time inside the gap: the best estimate of how long the loop was blocked. */
      readonly durationMs: number;
      readonly gapMs: number;
      /** Wall time of the previous tick, the earliest the stall can have started. */
      readonly startedAtWallMs: number;
      /** Idle time inside the gap beyond one tick (part of the gap was asleep or stopped). */
      readonly suspendedMs: number;
      readonly busySource: EventLoopBusySource;
      readonly usage: StallUsageDelta;
    }
  | {
      readonly kind: "suspended";
      readonly gapMs: number;
      readonly busyMs: number;
      readonly busySource: EventLoopBusySource;
    };

const NO_GAP: GapVerdict = { kind: "none" };

export interface ClassifyGapOptions {
  readonly tickMs: number;
  readonly thresholdMs: number;
}

const DEFAULT_CLASSIFY_OPTIONS: ClassifyGapOptions = {
  tickMs: EVENT_LOOP_TICK_MS,
  thresholdMs: EVENT_LOOP_STALL_THRESHOLD_MS,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const usageDelta = (previous: LoopTickReading, current: LoopTickReading): StallUsageDelta => ({
  cpuUserMs: Math.max(0, current.usage.userCPUTime - previous.usage.userCPUTime) / 1_000,
  cpuSystemMs: Math.max(0, current.usage.systemCPUTime - previous.usage.systemCPUTime) / 1_000,
  majorPageFaults: Math.max(0, current.usage.majorPageFault - previous.usage.majorPageFault),
  minorPageFaults: Math.max(0, current.usage.minorPageFault - previous.usage.minorPageFault),
  involuntaryContextSwitches: Math.max(
    0,
    current.usage.involuntaryContextSwitches - previous.usage.involuntaryContextSwitches,
  ),
});

/** ELU works when its cumulative counters have moved at all; Bun returns zeros forever. */
const hasEventLoopUtilization = (reading: LoopTickReading) =>
  reading.eluIdleMs + reading.eluActiveMs > 0;

/**
 * Classifies the gap between two consecutive ticks.
 *
 * - A gap shorter than the threshold is normal.
 * - Busy time (ELU active, or CPU time without ELU) of at least the threshold is a stall. The
 *   threshold applies to the busy time rather than to how late the tick was, so a 2.2 s block
 *   that began just before a tick was due (late by only 1.9 s) is still recorded.
 * - Otherwise, idle lateness of at least the threshold is a suspension: never a stall.
 */
export const classifyGap = (
  previous: LoopTickReading,
  current: LoopTickReading,
  options: ClassifyGapOptions = DEFAULT_CLASSIFY_OPTIONS,
): GapVerdict => {
  const gapMs = current.monotonicMs - previous.monotonicMs;
  if (!(gapMs >= options.thresholdMs)) return NO_GAP;
  const lateMs = gapMs - options.tickMs;
  const usage = usageDelta(previous, current);
  const busySource: EventLoopBusySource = hasEventLoopUtilization(current) ? "elu" : "cpu";
  const busyMs = clamp(
    busySource === "elu"
      ? current.eluActiveMs - previous.eluActiveMs
      : usage.cpuUserMs + usage.cpuSystemMs,
    0,
    gapMs,
  );
  if (busyMs >= options.thresholdMs) {
    return {
      kind: "stall",
      durationMs: Math.round(busyMs),
      gapMs: Math.round(gapMs),
      startedAtWallMs: previous.wallMs,
      suspendedMs: Math.max(0, Math.round(lateMs - busyMs)),
      busySource,
      usage,
    };
  }
  if (lateMs - busyMs >= options.thresholdMs) {
    return { kind: "suspended", gapMs: Math.round(gapMs), busyMs: Math.round(busyMs), busySource };
  }
  return NO_GAP;
};

/** Everything a record says about one stall, captured when the stall is detected. */
export interface StallEvidence {
  readonly kind: EventLoopStallKind;
  readonly durationMs: number;
  readonly startedAtWallMs: number;
  readonly detectedAtWallMs: number;
  readonly suspendedMs?: number | undefined;
  readonly busySource?: EventLoopBusySource | undefined;
  readonly usage?: StallUsageDelta | undefined;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly loadAverage1m: number | undefined;
  readonly phases: ReadonlyArray<string>;
  readonly uptimeMs: number;
}

export interface StallRecordContext {
  readonly pid: number;
  readonly cpuCount: number;
}

const toIso = (wallMs: number) => new Date(wallMs).toISOString();

export const stallLineFromEvidence = (
  evidence: StallEvidence,
  aggregate: { readonly count: number; readonly totalMs: number; readonly timeMs: number },
  context: StallRecordContext,
): EventLoopStallLine => ({
  time: toIso(aggregate.timeMs),
  kind: evidence.kind,
  durationMs: Math.round(evidence.durationMs),
  startedAt: toIso(evidence.startedAtWallMs),
  count: aggregate.count,
  totalMs: Math.round(aggregate.totalMs),
  ...(evidence.suspendedMs !== undefined ? { suspendedMs: evidence.suspendedMs } : {}),
  ...(evidence.busySource !== undefined ? { busySource: evidence.busySource } : {}),
  ...(evidence.usage !== undefined
    ? {
        cpuUserMs: Math.round(evidence.usage.cpuUserMs),
        cpuSystemMs: Math.round(evidence.usage.cpuSystemMs),
        majorPageFaults: evidence.usage.majorPageFaults,
        minorPageFaults: evidence.usage.minorPageFaults,
        involuntaryContextSwitches: evidence.usage.involuntaryContextSwitches,
      }
    : {}),
  rssBytes: evidence.rssBytes,
  heapUsedBytes: evidence.heapUsedBytes,
  ...(evidence.loadAverage1m !== undefined ? { loadAverage1m: evidence.loadAverage1m } : {}),
  cpuCount: context.cpuCount,
  ...(evidence.phases.length > 0 ? { phases: evidence.phases } : {}),
  pid: context.pid,
  uptimeMs: Math.round(evidence.uptimeMs),
});

interface KindAggregate {
  count: number;
  totalMs: number;
  longest: StallEvidence;
}

export interface StallWindowClose {
  /** Summary records of the stalls after the first of each kind. */
  readonly lines: ReadonlyArray<EventLoopStallLine>;
  /** Longest event-loop stall of the window, the immediately written one included; 0 if none. */
  readonly longestStallMs: number;
  readonly suspendedGapCount: number;
  readonly longestSuspendedGapMs: number;
}

export interface StallWindow {
  /** Adds a stall; returns the record to write now when it is the first of its kind this window. */
  readonly add: (evidence: StallEvidence) => EventLoopStallLine | null;
  readonly noteSuspended: (gapMs: number) => void;
  readonly close: (nowWallMs: number) => StallWindowClose;
}

const STALL_KINDS: ReadonlyArray<EventLoopStallKind> = [
  "event-loop",
  "threadpool",
  "threadpool-pending",
];

/**
 * Bounds the records per window: at most two per kind (the first stall at once, the rest as one
 * summary at close), so a loop that stalls continuously cannot rotate the file in minutes.
 */
export const makeStallWindow = (context: StallRecordContext): StallWindow => {
  const firstWritten = new Set<EventLoopStallKind>();
  const rest = new Map<EventLoopStallKind, KindAggregate>();
  let longestStallMs = 0;
  let suspendedGapCount = 0;
  let longestSuspendedGapMs = 0;
  return {
    add(evidence) {
      if (evidence.kind === "event-loop") {
        longestStallMs = Math.max(longestStallMs, evidence.durationMs);
      }
      if (!firstWritten.has(evidence.kind)) {
        firstWritten.add(evidence.kind);
        return stallLineFromEvidence(
          evidence,
          { count: 1, totalMs: evidence.durationMs, timeMs: evidence.detectedAtWallMs },
          context,
        );
      }
      const aggregate = rest.get(evidence.kind);
      if (aggregate === undefined) {
        rest.set(evidence.kind, { count: 1, totalMs: evidence.durationMs, longest: evidence });
      } else {
        aggregate.count += 1;
        aggregate.totalMs += evidence.durationMs;
        if (evidence.durationMs > aggregate.longest.durationMs) aggregate.longest = evidence;
      }
      return null;
    },
    noteSuspended(gapMs) {
      suspendedGapCount += 1;
      longestSuspendedGapMs = Math.max(longestSuspendedGapMs, gapMs);
    },
    close(nowWallMs) {
      const lines = STALL_KINDS.flatMap((kind) => {
        const aggregate = rest.get(kind);
        return aggregate === undefined
          ? []
          : [
              stallLineFromEvidence(
                aggregate.longest,
                { count: aggregate.count, totalMs: aggregate.totalMs, timeMs: nowWallMs },
                context,
              ),
            ];
      });
      const result = { lines, longestStallMs, suspendedGapCount, longestSuspendedGapMs };
      firstWritten.clear();
      rest.clear();
      longestStallMs = 0;
      suspendedGapCount = 0;
      longestSuspendedGapMs = 0;
      return result;
    },
  };
};

export interface EventLoopSamplerDeps {
  readonly read: () => LoopTickReading;
  /** Must run on the same clock as `read().monotonicMs`. */
  readonly canary: ThreadpoolCanary;
  readonly memory: () => { readonly rssBytes: number; readonly heapUsedBytes: number };
  readonly loadAverage1m: () => number | undefined;
  readonly uptimeMs: () => number;
  /** Tracked phases that overlapped the wall-clock interval, at most {@link STALL_PHASE_LIMIT}. */
  readonly phases: (startWallMs: number, endWallMs: number) => ReadonlyArray<string>;
  readonly pid: number;
  readonly cpuCount: number;
  readonly tickMs?: number;
  readonly thresholdMs?: number;
  readonly threadpoolThresholdMs?: number;
}

export interface EventLoopWindowSummary extends StallWindowClose {
  /** Busy fraction of the window (ELU, or CPU time without ELU), 0..1. */
  readonly utilization: number;
}

export interface EventLoopSampler {
  /** Runs one tick; returns records to write now. Never throws on a normal reading. */
  readonly tick: () => ReadonlyArray<EventLoopStallLine>;
  readonly closeWindow: () => EventLoopWindowSummary;
}

export const makeEventLoopSampler = (deps: EventLoopSamplerDeps): EventLoopSampler => {
  const classifyOptions: ClassifyGapOptions = {
    tickMs: deps.tickMs ?? EVENT_LOOP_TICK_MS,
    thresholdMs: deps.thresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS,
  };
  const threadpoolThresholdMs = deps.threadpoolThresholdMs ?? THREADPOOL_STALL_THRESHOLD_MS;
  // A gap this long can hold a canary's callback past the threadpool threshold, whatever its
  // verdict (a gap partly busy and partly asleep is neither a stall nor a suspension).
  const longGapMs = Math.min(classifyOptions.thresholdMs, threadpoolThresholdMs);
  const window = makeStallWindow({ pid: deps.pid, cpuCount: deps.cpuCount });
  const loopGaps: Array<{ readonly startMs: number; readonly endMs: number }> = [];
  let previous = deps.read();
  let windowStart = previous;

  const overlapsLoopGap = (startMs: number, endMs: number) =>
    loopGaps.some((gap) => startMs < gap.endMs && endMs > gap.startMs);

  const evidence = (
    fields: Pick<
      StallEvidence,
      "kind" | "durationMs" | "startedAtWallMs" | "suspendedMs" | "busySource" | "usage"
    >,
    current: LoopTickReading,
  ): StallEvidence => {
    const memory = deps.memory();
    return {
      ...fields,
      detectedAtWallMs: current.wallMs,
      rssBytes: memory.rssBytes,
      heapUsedBytes: memory.heapUsedBytes,
      loadAverage1m: deps.loadAverage1m(),
      phases: deps.phases(fields.startedAtWallMs, current.wallMs),
      uptimeMs: deps.uptimeMs(),
    };
  };

  return {
    tick() {
      const current = deps.read();
      const verdict = classifyGap(previous, current, classifyOptions);
      const lines: Array<EventLoopStallLine> = [];
      if (current.monotonicMs - previous.monotonicMs >= longGapMs) {
        loopGaps.push({ startMs: previous.monotonicMs, endMs: current.monotonicMs });
        if (loopGaps.length > LOOP_GAP_HISTORY_LIMIT) loopGaps.shift();
      }
      if (verdict.kind === "stall") {
        const line = window.add(
          evidence(
            {
              kind: "event-loop",
              durationMs: verdict.durationMs,
              startedAtWallMs: verdict.startedAtWallMs,
              suspendedMs: verdict.suspendedMs,
              busySource: verdict.busySource,
              usage: verdict.usage,
            },
            current,
          ),
        );
        if (line !== null) lines.push(line);
      } else if (verdict.kind === "suspended") {
        window.noteSuspended(verdict.gapMs);
      }

      const probe = deps.canary.probe();
      const toWallMs = (monotonicMs: number) =>
        current.wallMs - (current.monotonicMs - monotonicMs);
      for (const settled of probe.settled) {
        // Already recorded as `threadpool-pending`: one saturation, one record.
        if (settled.reportedPending) continue;
        const latencyMs = settled.settledAtMs - settled.startedAtMs;
        // A blocked or suspended loop delays the callback as well: not threadpool evidence.
        if (latencyMs < threadpoolThresholdMs) continue;
        if (overlapsLoopGap(settled.startedAtMs, settled.settledAtMs)) continue;
        const line = window.add(
          evidence(
            {
              kind: "threadpool",
              durationMs: Math.round(latencyMs),
              startedAtWallMs: toWallMs(settled.startedAtMs),
            },
            current,
          ),
        );
        if (line !== null) lines.push(line);
      }
      const pending = probe.pending;
      if (pending !== null && !pending.reported) {
        // Count only time the loop was free: the last gap may be what held the callback.
        const freeSinceMs = Math.max(pending.startedAtMs, loopGaps.at(-1)?.endMs ?? -Infinity);
        const pendingMs = current.monotonicMs - freeSinceMs;
        if (pendingMs >= threadpoolThresholdMs) {
          deps.canary.markPendingReported();
          const line = window.add(
            evidence(
              {
                kind: "threadpool-pending",
                durationMs: Math.round(pendingMs),
                startedAtWallMs: toWallMs(freeSinceMs),
              },
              current,
            ),
          );
          if (line !== null) lines.push(line);
        }
      }
      previous = current;
      return lines;
    },
    closeWindow() {
      const current = deps.read();
      const elapsedMs = Math.max(1, current.monotonicMs - windowStart.monotonicMs);
      const utilization = hasEventLoopUtilization(current)
        ? (current.eluActiveMs - windowStart.eluActiveMs) /
          Math.max(
            1e-6,
            current.eluActiveMs -
              windowStart.eluActiveMs +
              current.eluIdleMs -
              windowStart.eluIdleMs,
          )
        : (current.usage.userCPUTime -
            windowStart.usage.userCPUTime +
            current.usage.systemCPUTime -
            windowStart.usage.systemCPUTime) /
          1_000 /
          elapsedMs;
      windowStart = current;
      return { ...window.close(current.wallMs), utilization: clamp(utilization, 0, 1) };
    },
  };
};

/** The sampler as the server runs it: real clocks, counters, phases and canary. */
export const makeDefaultEventLoopSamplerDeps = (): EventLoopSamplerDeps => ({
  read: readLoopTick,
  canary: makeThreadpoolCanary({
    now: () => performance.now(),
    minIssueIntervalMs: THREADPOOL_CANARY_INTERVAL_MS,
  }),
  memory: () => {
    const memory = process.memoryUsage();
    return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
  },
  // os.loadavg() is always 0 on Windows: leave it out rather than claim an idle machine.
  loadAverage1m: () => (process.platform === "win32" ? undefined : NodeOS.loadavg()[0]),
  uptimeMs: () => process.uptime() * 1_000,
  phases: (startWallMs, endWallMs) =>
    describeStartupPhasesInInterval(startWallMs, endWallMs, STALL_PHASE_LIMIT).map(
      truncateStallPhase,
    ),
  pid: process.pid,
  cpuCount:
    typeof NodeOS.availableParallelism === "function"
      ? NodeOS.availableParallelism()
      : NodeOS.cpus().length,
});

export interface EventLoopMonitorOptions {
  /** `event-loop-stalls.ndjson`; see {@link eventLoopStallLogPath}. */
  readonly logPath: string;
  readonly sampler?: EventLoopSamplerDeps;
  readonly windowMs?: number;
  /** Starts the ticker and returns its stop function; default an unref'd `setInterval`. */
  readonly startTicker?: (onTick: () => void, intervalMs: number) => () => void;
}

const startIntervalTicker = (onTick: () => void, intervalMs: number) => {
  const handle = setInterval(onTick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
};

const stallMessage = (line: EventLoopStallLine) => {
  const subject =
    line.kind === "event-loop"
      ? "event loop stalled"
      : line.kind === "threadpool-pending"
        ? "libuv threadpool request pending"
        : "libuv threadpool stalled";
  const repeated = line.count > 1 ? ` (${line.count} stalls, ${line.totalMs} ms in total)` : "";
  return `${subject} for ${line.durationMs} ms${repeated}`;
};

const stallSpanAttributes = (line: EventLoopStallLine): Record<string, unknown> => {
  const { time: _time, phases, ...fields } = line;
  return { ...fields, ...(phases !== undefined ? { phases: phases.join("; ") } : {}) };
};

const emitStallTelemetry = (line: EventLoopStallLine) => {
  const { time: _time, ...fields } = line;
  return Effect.logWarning(stallMessage(line), fields).pipe(
    Effect.withSpan(
      line.kind === "event-loop" ? "server.eventLoop.stall" : "server.threadpool.stall",
      {
        root: true,
        level: "Warn",
        attributes: stallSpanAttributes(line),
      },
    ),
    Effect.andThen(increment(serverEventLoopStallsTotal, { kind: line.kind }, line.count)),
  );
};

/**
 * Runs the monitor for the life of the enclosing scope. Closing the scope stops the ticker, writes
 * the open window's summary records and waits for the stall log to be flushed. A monitor that
 * cannot take readings logs why and stays off; it never fails the server.
 */
export const makeEventLoopMonitor = (
  options: EventLoopMonitorOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(services);
    const windowMs = options.windowMs ?? EVENT_LOOP_WINDOW_MS;

    // The sampler takes its first reading here, before anything is opened or started.
    let sampler: EventLoopSampler;
    let tickMs: number;
    try {
      const samplerDeps = options.sampler ?? makeDefaultEventLoopSamplerDeps();
      tickMs = samplerDeps.tickMs ?? EVENT_LOOP_TICK_MS;
      sampler = makeEventLoopSampler(samplerDeps);
    } catch (cause) {
      yield* logOnceEvery({
        key: "event-loop-monitor-start",
        message: "The event-loop monitor could not start; stalls are not recorded",
        cause,
      });
      return;
    }

    const reportReadingFailure = (cause: unknown) =>
      logOnceEvery({
        key: "event-loop-monitor-tick",
        message: "The event-loop monitor could not take a reading",
        cause,
      });
    const reportWriteFailure = (cause: unknown) =>
      logOnceEvery({
        key: "event-loop-stall-log-write",
        message: "Could not write the event-loop stall log",
        fields: { path: options.logPath },
        cause,
      });
    // Async: a stall monitor must never block on a slow disk. throwOnError makes a failed write
    // reject so it can be reported; the sink stays usable for the next one.
    const sink = new AsyncRotatingFileSink({
      filePath: options.logPath,
      maxBytes: EVENT_LOOP_STALL_LOG_MAX_BYTES,
      maxFiles: EVENT_LOOP_STALL_LOG_MAX_FILES,
      throwOnError: true,
    });
    // Observe initialization now: a rejected init with no write queued would be unhandled.
    sink.flush().catch((cause: unknown) => {
      runFork(reportWriteFailure(cause));
    });
    const writeLine = (line: EventLoopStallLine): Promise<void> =>
      sink.write(`${encodeStallLine(line)}\n`).catch((cause: unknown) => {
        runFork(reportWriteFailure(cause));
      });

    const onTick = () => {
      let lines: ReadonlyArray<EventLoopStallLine>;
      try {
        lines = sampler.tick();
      } catch (cause) {
        runFork(reportReadingFailure(cause));
        return;
      }
      for (const line of lines) {
        // Queued on the sink synchronously, so a shutdown right after still writes it.
        void writeLine(line);
        runFork(emitStallTelemetry(line));
      }
    };

    const closeWindow = Effect.uninterruptible(
      Effect.gen(function* () {
        let summary: EventLoopWindowSummary;
        try {
          summary = sampler.closeWindow();
        } catch (cause) {
          yield* reportReadingFailure(cause);
          return [];
        }
        const written = summary.lines.map(writeLine);
        yield* Metric.update(serverEventLoopStallMaxMs, summary.longestStallMs);
        yield* Metric.update(serverEventLoopUtilization, summary.utilization);
        if (summary.suspendedGapCount > 0) {
          yield* Effect.logDebug("event loop gap while idle", {
            gaps: summary.suspendedGapCount,
            longestGapMs: summary.longestSuspendedGapMs,
          });
        }
        for (const line of summary.lines) yield* emitStallTelemetry(line);
        return written;
      }),
    );

    // Finalizers run in reverse: the window fiber stops, then the ticker, then the open window is
    // written and the log flushed. Neither promise rejects (writes catch, `close` swallows).
    yield* Effect.addFinalizer(() =>
      closeWindow.pipe(
        Effect.flatMap((written) => Effect.promise(() => Promise.all(written))),
        Effect.ensuring(Effect.promise(() => sink.close())),
      ),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => (options.startTicker ?? startIntervalTicker)(onTick, tickMs)),
      (stop) => Effect.sync(stop),
    );
    yield* Effect.sleep(windowMs).pipe(
      Effect.andThen(closeWindow),
      Effect.forever,
      Effect.forkScoped,
    );
  });

/**
 * The lifetime monitor, writing next to the configured trace file. Only `makeServerLayer` provides
 * it: provider tests and CLI commands must not start a lifetime ticker or write stall files.
 */
export const EventLoopMonitorLive: Layer.Layer<never, never, ServerConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* makeEventLoopMonitor({ logPath: eventLoopStallLogPath(config.serverTracePath) });
  }),
);
