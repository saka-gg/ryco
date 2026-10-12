import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import {
  describeStartupPhasesOverlapping,
  runStartupStallMonitor,
  type StartupStallReport,
  trackStartupPhase,
} from "./startupStallMonitor.ts";

const blockEventLoop = (ms: number) =>
  Effect.sync(() => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // Busy-wait: simulates synchronous work that stalls the event loop.
    }
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

  it.live("reports an event-loop stall with the phase that caused it", () =>
    Effect.gen(function* () {
      const reports: Array<StartupStallReport> = [];
      const phase = `test.blocking.${crypto.randomUUID()}`;
      const monitor = yield* runStartupStallMonitor(
        { windowMs: 1_500, sampleIntervalMs: 20, eventLoopStallMs: 150, threadpoolStallMs: 10_000 },
        (report) => Effect.sync(() => reports.push(report)),
      ).pipe(Effect.forkChild);
      yield* Effect.sleep("100 millis");
      yield* trackStartupPhase(phase, blockEventLoop(300));
      yield* Effect.sleep("200 millis");
      yield* Fiber.interrupt(monitor);

      const stall = reports.find((report) => report.kind === "event-loop");
      expect(stall?.delayMs).toBeGreaterThanOrEqual(150);
      expect(stall?.phases.some((name) => name.startsWith(phase))).toBe(true);
    }),
  );
});
