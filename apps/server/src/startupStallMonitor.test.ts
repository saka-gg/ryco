import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import {
  describeStartupPhasesOverlapping,
  runStartupStallMonitor,
  type StartupStallReport,
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
