/**
 * Startup stall monitor — event-loop and libuv threadpool instrumentation for the first 30 s.
 *
 * Installed backends occasionally stall for 3–15 s before the HTTP listener binds, with several
 * unrelated provider drivers finishing within milliseconds of each other. That pattern fits a
 * blocked event loop or a saturated libuv threadpool (stuck fs or DNS work), but the logs cannot
 * tell which. This monitor samples both during startup and logs a `startup stall` warning that
 * names the phases in flight:
 *
 *   - event loop: `perf_hooks.monitorEventLoopDelay`, maximum delay per sample interval;
 *   - threadpool: a canary `fs.stat(os.tmpdir())` issued every sample interval, whose callback
 *     latency is the queueing delay of the shared libuv pool. A canary that is still pending past
 *     the threshold is reported immediately, so a long stall is visible while it happens.
 *
 * Phases are registered with {@link trackStartupPhase}. The registry is process-wide on purpose:
 * startup phases run in unrelated layers and fibers, and the monitor must see all of them. The
 * durations of the boot-defining phases are also forwarded to the desktop shell (fd 4), so
 * desktop-main.log attributes a slow launch without waiting for a stall warning.
 *
 * @module startupStallMonitor
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { Effect, Layer } from "effect";

import { recordDesktopStartupPhaseDuration } from "./desktopLifecycle.ts";

export interface StartupStallMonitorOptions {
  readonly windowMs: number;
  readonly sampleIntervalMs: number;
  readonly eventLoopStallMs: number;
  readonly threadpoolStallMs: number;
}

export const DEFAULT_STARTUP_STALL_MONITOR_OPTIONS: StartupStallMonitorOptions = {
  windowMs: 30_000,
  sampleIntervalMs: 100,
  eventLoopStallMs: 250,
  threadpoolStallMs: 500,
};

export interface StartupStallReport {
  readonly kind: "event-loop" | "threadpool" | "threadpool-pending";
  readonly delayMs: number;
  readonly sinceMonitorStartMs: number;
  readonly phases: ReadonlyArray<string>;
}

interface PhaseRecord {
  readonly name: string;
  readonly startedAtMs: number;
  readonly startedAtPerfMs: number;
  endedAtMs: number | null;
}

/**
 * Phases whose durations reach the desktop log. Provider probes (`provider.probe:*`) are left
 * out: they also run on every refresh long after startup.
 */
const DESKTOP_FORWARDED_PHASE_PREFIXES = [
  "persistence.",
  "provider.instance.create:",
  "provider.instances.",
  "provider.settings.",
  "provider.status-cache.",
  "server.startup.",
  "orchestration.",
  "agent-control.",
  "auth.",
] as const;

export const isDesktopForwardedStartupPhase = (name: string): boolean =>
  DESKTOP_FORWARDED_PHASE_PREFIXES.some((prefix) => name.startsWith(prefix));

const RECENT_PHASE_LIMIT = 64;
const inFlightPhases = new Map<number, PhaseRecord>();
const recentlyEndedPhases: Array<PhaseRecord> = [];
let nextPhaseId = 0;

const beginPhase = (name: string): number => {
  const id = nextPhaseId++;
  inFlightPhases.set(id, {
    name,
    startedAtMs: Date.now(),
    startedAtPerfMs: performance.now(),
    endedAtMs: null,
  });
  return id;
};

const endPhase = (id: number): void => {
  const record = inFlightPhases.get(id);
  if (!record) return;
  inFlightPhases.delete(id);
  record.endedAtMs = Date.now();
  recentlyEndedPhases.push(record);
  if (recentlyEndedPhases.length > RECENT_PHASE_LIMIT) recentlyEndedPhases.shift();
  if (isDesktopForwardedStartupPhase(record.name)) {
    recordDesktopStartupPhaseDuration(record.name, record.startedAtPerfMs, performance.now());
  }
};

/**
 * Mark `effect` as a named startup phase for stall attribution. Costs two map operations; safe to
 * use outside startup as well (desktop duration frames stop after the startup window).
 */
export const trackStartupPhase = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => beginPhase(name)),
    () => effect,
    (id) => Effect.sync(() => endPhase(id)),
  );

/**
 * {@link trackStartupPhase} for a whole layer build. The wrapped layer keeps its memoization, so
 * a shared dependency built elsewhere first is not counted again.
 */
export const trackStartupLayer = <ROut, E, RIn>(
  name: string,
  layer: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut, E, RIn> =>
  Layer.fromBuild((memoMap, scope) =>
    trackStartupPhase(name, Layer.buildWithMemoMap(layer, memoMap, scope)),
  );

/** `name (duration ms)`, with `, in flight` for a phase that has not ended by `nowMs`. */
const describePhase = (record: PhaseRecord, nowMs: number) =>
  `${record.name} (${(record.endedAtMs ?? nowMs) - record.startedAtMs} ms${
    record.endedAtMs === null ? ", in flight" : ""
  })`;

/**
 * Phases that overlapped `[nowMs - windowMs, nowMs]`: everything still in flight plus phases that
 * ended inside the window (a blocking phase usually completes before the delayed sample runs).
 */
export const describeStartupPhasesOverlapping = (
  nowMs: number,
  windowMs: number,
): ReadonlyArray<string> => {
  const windowStartMs = nowMs - windowMs;
  return [
    ...[...inFlightPhases.values()].map((record) => describePhase(record, nowMs)),
    ...recentlyEndedPhases
      .filter((record) => record.endedAtMs !== null && record.endedAtMs >= windowStartMs)
      .map((record) => describePhase(record, nowMs)),
  ];
};

const phaseOverlapMs = (record: PhaseRecord, startMs: number, endMs: number, nowMs: number) =>
  Math.max(0, Math.min(record.endedAtMs ?? nowMs, endMs) - Math.max(record.startedAtMs, startMs));

/**
 * Phases that overlapped the wall-clock interval `[startMs, endMs]`, for attributing a stall that
 * just ended. Unlike {@link describeStartupPhasesOverlapping}, phases that started after the
 * interval are left out. Phases that started or ended inside the interval come first (a blocking
 * phase usually ends right after the stall), longest overlap first; phases that covered the whole
 * interval follow, most recently started first. Both are capped at `limit`.
 */
export const describeStartupPhasesInInterval = (
  startMs: number,
  endMs: number,
  limit = Number.POSITIVE_INFINITY,
  nowMs = Date.now(),
): ReadonlyArray<string> => {
  const candidates = [...inFlightPhases.values(), ...recentlyEndedPhases].filter(
    (record) => record.startedAtMs <= endMs && (record.endedAtMs ?? nowMs) >= startMs,
  );
  const inside = candidates
    .filter(
      (record) =>
        record.startedAtMs > startMs || (record.endedAtMs !== null && record.endedAtMs < endMs),
    )
    .toSorted(
      (left, right) =>
        phaseOverlapMs(right, startMs, endMs, nowMs) - phaseOverlapMs(left, startMs, endMs, nowMs),
    );
  const insideSet = new Set(inside);
  const spanning = candidates
    .filter((record) => !insideSet.has(record))
    .toSorted((left, right) => right.startedAtMs - left.startedAtMs);
  return [...inside, ...spanning].slice(0, limit).map((record) => describePhase(record, nowMs));
};

/** One threadpool canary: issued and settled times on the canary's clock. */
export interface ThreadpoolCanaryResult {
  readonly startedAtMs: number;
  readonly settledAtMs: number;
  /** Whether {@link ThreadpoolCanary.markPendingReported} was called while it was pending. */
  readonly reportedPending: boolean;
}

export interface ThreadpoolCanaryProbe {
  /** Canaries that settled since the previous probe, oldest first. */
  readonly settled: ReadonlyArray<ThreadpoolCanaryResult>;
  /**
   * The canary that was already in flight at this probe, if any; a probe that finds none issues
   * a new one and reports it here only from the next probe on.
   */
  readonly pending: { readonly startedAtMs: number; readonly reported: boolean } | null;
}

export interface ThreadpoolCanary {
  readonly probe: () => ThreadpoolCanaryProbe;
  /** Marks the pending canary as reported, so it is reported once however long it hangs. */
  readonly markPendingReported: () => void;
}

export interface ThreadpoolCanaryOptions {
  /** Directory the canary `stat`s; default `os.tmpdir()`. */
  readonly directory?: string;
  /** Clock for issue and settle times; default `Date.now`. */
  readonly now?: () => number;
  /**
   * Least time between issuing two canaries; default 0 (a new one at the first probe after the
   * last settled). A pending canary is still checked at every probe.
   */
  readonly minIssueIntervalMs?: number;
  readonly stat?: (directory: string, callback: () => void) => void;
}

/**
 * A libuv threadpool canary: one `fs.stat` in flight at a time, whose callback latency is the
 * queueing delay of the shared pool (plus any event-loop block before the callback could run,
 * which callers that also watch the loop must discount).
 */
export const makeThreadpoolCanary = (options: ThreadpoolCanaryOptions = {}): ThreadpoolCanary => {
  const directory = options.directory ?? NodeOS.tmpdir();
  const now = options.now ?? Date.now;
  const minIssueIntervalMs = options.minIssueIntervalMs ?? 0;
  const stat = options.stat ?? ((target, callback) => NodeFS.stat(target, () => callback()));
  let pending: { readonly startedAtMs: number; reported: boolean } | null = null;
  let settled: Array<ThreadpoolCanaryResult> = [];
  let lastIssuedAtMs = Number.NEGATIVE_INFINITY;
  return {
    probe() {
      const taken = settled;
      settled = [];
      if (pending !== null) {
        return { settled: taken, pending: { ...pending } };
      }
      const issuedAtMs = now();
      if (issuedAtMs - lastIssuedAtMs < minIssueIntervalMs) {
        return { settled: taken, pending: null };
      }
      lastIssuedAtMs = issuedAtMs;
      const canary = { startedAtMs: issuedAtMs, reported: false };
      pending = canary;
      stat(directory, () => {
        settled.push({
          startedAtMs: canary.startedAtMs,
          settledAtMs: now(),
          reportedPending: canary.reported,
        });
        if (pending === canary) pending = null;
      });
      return { settled: taken, pending: null };
    },
    markPendingReported() {
      if (pending !== null) pending.reported = true;
    },
  };
};

const logStall = (report: StartupStallReport) =>
  Effect.logWarning("startup stall", {
    kind: report.kind,
    delayMs: report.delayMs,
    sinceMonitorStartMs: report.sinceMonitorStartMs,
    phases: report.phases,
  });

/**
 * Sample the event loop and the threadpool until `windowMs` has elapsed, reporting each stall.
 * Interrupting the effect stops sampling immediately.
 */
export const runStartupStallMonitor = (
  options: StartupStallMonitorOptions = DEFAULT_STARTUP_STALL_MONITOR_OPTIONS,
  onStall: (report: StartupStallReport) => Effect.Effect<void> = logStall,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const histogram = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const created = monitorEventLoopDelay({ resolution: 10 });
          created.enable();
          return created;
        }),
        (created) => Effect.sync(() => created.disable()),
      );
      const startedAtMs = Date.now();
      const canary = makeThreadpoolCanary();
      let stalls = 0;
      let maxEventLoopDelayMs = 0;
      let maxThreadpoolDelayMs = 0;

      const report = (kind: StartupStallReport["kind"], delayMs: number, nowMs: number) => {
        stalls += 1;
        return onStall({
          kind,
          delayMs,
          sinceMonitorStartMs: nowMs - startedAtMs,
          phases: describeStartupPhasesOverlapping(nowMs, delayMs + options.sampleIntervalMs),
        });
      };

      while (Date.now() - startedAtMs < options.windowMs) {
        yield* Effect.sleep(options.sampleIntervalMs);
        const nowMs = Date.now();

        const eventLoopDelayMs = Math.round(histogram.max / 1e6);
        histogram.reset();
        maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, eventLoopDelayMs);
        if (eventLoopDelayMs >= options.eventLoopStallMs) {
          yield* report("event-loop", eventLoopDelayMs, nowMs);
        }

        const probe = canary.probe();
        for (const settled of probe.settled) {
          const delayMs = settled.settledAtMs - settled.startedAtMs;
          maxThreadpoolDelayMs = Math.max(maxThreadpoolDelayMs, delayMs);
          if (delayMs >= options.threadpoolStallMs) yield* report("threadpool", delayMs, nowMs);
        }
        const pending = probe.pending;
        if (
          pending !== null &&
          !pending.reported &&
          nowMs - pending.startedAtMs >= options.threadpoolStallMs
        ) {
          canary.markPendingReported();
          yield* report("threadpool-pending", nowMs - pending.startedAtMs, nowMs);
        }
      }

      const summary = {
        windowMs: options.windowMs,
        stalls,
        maxEventLoopDelayMs,
        maxThreadpoolDelayMs,
      };
      yield* stalls > 0
        ? Effect.logInfo("startup stall monitor finished", summary)
        : Effect.logDebug("startup stall monitor finished", summary);
    }),
  );

/**
 * Runs the monitor in the background for the lifetime of the enclosing layer scope. Provide this
 * exact value wherever monitoring should start: layer memoization keeps it to one monitor per
 * runtime build, started by whichever layer is built first.
 */
export const StartupStallMonitorLive: Layer.Layer<never> = Layer.effectDiscard(
  runStartupStallMonitor().pipe(Effect.forkScoped),
);
