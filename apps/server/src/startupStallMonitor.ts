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

/**
 * Phases that overlapped `[nowMs - windowMs, nowMs]`: everything still in flight plus phases that
 * ended inside the window (a blocking phase usually completes before the delayed sample runs).
 */
export const describeStartupPhasesOverlapping = (
  nowMs: number,
  windowMs: number,
): ReadonlyArray<string> => {
  const windowStartMs = nowMs - windowMs;
  const describe = (record: PhaseRecord) =>
    `${record.name} (${(record.endedAtMs ?? nowMs) - record.startedAtMs} ms${
      record.endedAtMs === null ? ", in flight" : ""
    })`;
  return [
    ...[...inFlightPhases.values()].map(describe),
    ...recentlyEndedPhases
      .filter((record) => record.endedAtMs !== null && record.endedAtMs >= windowStartMs)
      .map(describe),
  ];
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
      const canaryDirectory = NodeOS.tmpdir();
      let pendingCanary: { readonly startedAtMs: number; reported: boolean } | null = null;
      const settledCanaryDelays: Array<number> = [];
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

        for (const delayMs of settledCanaryDelays.splice(0)) {
          maxThreadpoolDelayMs = Math.max(maxThreadpoolDelayMs, delayMs);
          if (delayMs >= options.threadpoolStallMs) yield* report("threadpool", delayMs, nowMs);
        }
        if (pendingCanary === null) {
          const canary = { startedAtMs: nowMs, reported: false };
          pendingCanary = canary;
          NodeFS.stat(canaryDirectory, () => {
            settledCanaryDelays.push(Date.now() - canary.startedAtMs);
            if (pendingCanary === canary) pendingCanary = null;
          });
        } else if (
          !pendingCanary.reported &&
          nowMs - pendingCanary.startedAtMs >= options.threadpoolStallMs
        ) {
          pendingCanary.reported = true;
          yield* report("threadpool-pending", nowMs - pendingCanary.startedAtMs, nowMs);
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
