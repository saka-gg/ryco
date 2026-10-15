import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import {
  attachDesktopLifecycleChannel,
  DESKTOP_STARTUP_PHASE_FORWARD_MAX_FRAMES,
  DESKTOP_STARTUP_COMPLETE_PHASE,
  DESKTOP_STARTUP_PROVIDERS_READY_PHASE,
  detachDesktopLifecycleChannelForTests,
  recordDesktopStartupPhase,
  recordDesktopStartupPhaseDuration,
} from "./desktopLifecycle.ts";
import {
  describeStartupPhasesOverlapping,
  runStartupStallMonitor,
  type StartupStallReport,
  trackStartupLayer,
  trackStartupPhase,
} from "./startupStallMonitor.ts";

// Native histogram sampling and JS timers can run in either order after a busy-wait.
// Control the sensor and the sampling clock so CI load cannot hide the stall.
const histogram = vi.hoisted(() => {
  const sensor = {
    max: 0,
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(() => {
      sensor.max = 0;
    }),
  };
  return sensor;
});

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return { ...actual, monitorEventLoopDelay: vi.fn(() => histogram) };
});

describe("startupStallMonitor", () => {
  it.effect("reports phases in flight and phases that ended inside the window", () =>
    Effect.gen(function* () {
      const name = `test.phase.${crypto.randomUUID()}`;
      const inFlight = yield* trackStartupPhase(
        name,
        Effect.sync(() => describeStartupPhasesOverlapping(Date.now(), 1_000)),
      );
      expect(inFlight.some((phase) => phase.startsWith(name) && phase.includes("in flight"))).toBe(
        true,
      );

      const afterEnd = describeStartupPhasesOverlapping(Date.now(), 1_000);
      expect(afterEnd.some((phase) => phase.startsWith(name) && !phase.includes("in flight"))).toBe(
        true,
      );
      // Long after the window it is no longer attributed.
      expect(
        describeStartupPhasesOverlapping(Date.now() + 60_000, 1_000).some((phase) =>
          phase.startsWith(name),
        ),
      ).toBe(false);
    }),
  );

  it.effect("reports an event-loop stall with the phase that caused it", () =>
    Effect.gen(function* () {
      const reports: Array<StartupStallReport> = [];
      const phase = `test.blocking.${crypto.randomUUID()}`;
      const monitor = yield* runStartupStallMonitor(
        { windowMs: 1_500, sampleIntervalMs: 20, eventLoopStallMs: 150, threadpoolStallMs: 10_000 },
        (report) => Effect.sync(() => reports.push(report)),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(20);
      expect(reports).toEqual([]);
      yield* trackStartupPhase(
        phase,
        Effect.sync(() => {
          histogram.max = 300_000_000;
        }),
      );
      yield* TestClock.adjust(20);
      yield* TestClock.adjust(20);
      yield* Fiber.interrupt(monitor);

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ kind: "event-loop", delayMs: 300 });
      expect(reports[0]?.phases.some((name) => name.startsWith(phase))).toBe(true);
      expect(histogram.enable).toHaveBeenCalledOnce();
      expect(histogram.disable).toHaveBeenCalledOnce();
    }),
  );
});

describe("desktop startup phase durations", () => {
  const captureFrames = () => {
    const channel = new PassThrough();
    const chunks: Array<string> = [];
    channel.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    attachDesktopLifecycleChannel(channel);
    return () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  // Milliseconds since process start, as the backend reports them; a long test run must not
  // push the readings past the startup window.
  const clockAt = (...readings: Array<number>) => {
    const spy = vi.spyOn(performance, "now");
    for (const reading of readings) spy.mockReturnValueOnce(reading);
    return spy;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    detachDesktopLifecycleChannelForTests();
  });

  it.effect("forwards boot-defining phases with their duration", () =>
    Effect.gen(function* () {
      const frames = captureFrames();
      clockAt(100, 740);
      yield* trackStartupPhase("persistence.migrations.ledger", Effect.void);
      clockAt(800, 812);
      yield* trackStartupPhase("server.startup.reactors.start", Effect.void);
      clockAt(900, 1_400);
      yield* trackStartupPhase("orchestration.projection.bootstrap", Effect.void);
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      expect(frames()).toEqual([
        { type: "startup-phase", name: "persistence.migrations.ledger", ms: 740, durationMs: 640 },
        { type: "startup-phase", name: "server.startup.reactors.start", ms: 812, durationMs: 12 },
        {
          type: "startup-phase",
          name: "orchestration.projection.bootstrap",
          ms: 1_400,
          durationMs: 500,
        },
      ]);
    }),
  );

  it.effect("times a whole layer build", () =>
    Effect.gen(function* () {
      const frames = captureFrames();
      clockAt(200, 260);
      yield* Effect.scoped(Layer.build(trackStartupLayer("auth.layer.build", Layer.empty)));
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      expect(frames()).toEqual([
        { type: "startup-phase", name: "auth.layer.build", ms: 260, durationMs: 60 },
      ]);
    }),
  );

  it.effect("does not forward provider probes, unrelated phases or phases after startup", () =>
    Effect.gen(function* () {
      const frames = captureFrames();
      // Phases that are not forwarded read the clock only when they begin.
      clockAt(100);
      yield* trackStartupPhase("provider.probe:codex", Effect.void);
      clockAt(100);
      yield* trackStartupPhase("test.unrelated", Effect.void);
      // A settings hot reload re-creating an instance long after startup.
      clockAt(90_000, 90_050);
      yield* trackStartupPhase("provider.instance.create:codex", Effect.void);
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      expect(frames()).toEqual([]);
    }),
  );

  it.effect("forwards a phase that began during startup but ended after the window", () =>
    Effect.gen(function* () {
      const frames = captureFrames();
      // First boot after an upgrade: the migration ledger backfill outlasts the startup window.
      clockAt(50_000, 75_000);
      yield* trackStartupPhase("persistence.migrations.ledger", Effect.void);
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      expect(frames()).toEqual([
        {
          type: "startup-phase",
          name: "persistence.migrations.ledger",
          ms: 75_000,
          durationMs: 25_000,
        },
      ]);
    }),
  );

  it.effect("forwards the initial provider build that starts after `complete`", () =>
    Effect.gen(function* () {
      const frames = captureFrames();
      clockAt(3_000);
      recordDesktopStartupPhase(DESKTOP_STARTUP_COMPLETE_PHASE);
      // Began before `complete` and ended after it.
      recordDesktopStartupPhaseDuration("provider.instance.create:cursor", 2_000, 3_500);
      // The listener serves, the boot gate opens and the initial reconcile builds the drivers.
      clockAt(3_001, 3_020, 3_090, 3_100);
      yield* trackStartupPhase(
        "provider.instances.reconcile",
        trackStartupPhase("provider.instance.create:codex", Effect.void),
      );
      clockAt(3_101);
      recordDesktopStartupPhase(DESKTOP_STARTUP_PROVIDERS_READY_PHASE);
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      expect(frames()).toEqual([
        { type: "startup-phase", name: DESKTOP_STARTUP_COMPLETE_PHASE, ms: 3_000 },
        {
          type: "startup-phase",
          name: "provider.instance.create:cursor",
          ms: 3_500,
          durationMs: 1_500,
        },
        {
          type: "startup-phase",
          name: "provider.instance.create:codex",
          ms: 3_090,
          durationMs: 70,
        },
        {
          type: "startup-phase",
          name: "provider.instances.reconcile",
          ms: 3_100,
          durationMs: 99,
        },
        { type: "startup-phase", name: DESKTOP_STARTUP_PROVIDERS_READY_PHASE, ms: 3_101 },
      ]);
    }),
  );

  it.effect("stops forwarding phases that begin after both end milestones", () =>
    Effect.gen(function* () {
      const frames = captureFrames();
      // The provider build may also settle first; startup ends at the later milestone.
      clockAt(2_500);
      recordDesktopStartupPhase(DESKTOP_STARTUP_PROVIDERS_READY_PHASE);
      clockAt(2_600, 2_700);
      yield* trackStartupPhase("orchestration.projection.bootstrap", Effect.void);
      clockAt(3_000);
      recordDesktopStartupPhase(DESKTOP_STARTUP_COMPLETE_PHASE);
      // A settings change re-creating an instance well inside the window, after startup.
      clockAt(4_000, 4_200, 4_210);
      yield* trackStartupPhase(
        "provider.instances.reconcile",
        trackStartupPhase("provider.instance.create:codex", Effect.void),
      );
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

      expect(frames()).toEqual([
        { type: "startup-phase", name: DESKTOP_STARTUP_PROVIDERS_READY_PHASE, ms: 2_500 },
        {
          type: "startup-phase",
          name: "orchestration.projection.bootstrap",
          ms: 2_700,
          durationMs: 100,
        },
        { type: "startup-phase", name: DESKTOP_STARTUP_COMPLETE_PHASE, ms: 3_000 },
      ]);
    }),
  );

  it("caps the number of forwarded frames", async () => {
    const frames = captureFrames();
    for (let index = 0; index < DESKTOP_STARTUP_PHASE_FORWARD_MAX_FRAMES + 10; index += 1) {
      recordDesktopStartupPhaseDuration(`provider.instance.create:i${index}`, 10, 20);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(frames()).toHaveLength(DESKTOP_STARTUP_PHASE_FORWARD_MAX_FRAMES);
  });
});
