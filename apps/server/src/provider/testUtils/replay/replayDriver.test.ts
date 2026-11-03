import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Queue } from "effect";

import { runReplayCursor } from "./replayDriver.ts";
import { makeReplayGate, openReplayGate, type ReplayGate } from "./replayGate.ts";
import { makeReplayCursor, ReplayInvalidInboundError, type ReplayError } from "./replayMatch.ts";
import type { ReplayEntry } from "./replayTranscript.ts";

/** A transport that records what the driver does to it; a `bad` frame cannot be delivered. */
const makeTransport = (entries: ReadonlyArray<ReplayEntry>, gate: ReplayGate = openReplayGate) =>
  Effect.gen(function* () {
    const scenario = "driver-unit";
    const outbound = yield* Queue.unbounded<unknown>();
    const delivered = yield* Queue.unbounded<unknown>();
    const failure = yield* Deferred.make<ReplayError>();
    const stops: Array<string> = [];
    let state = "running";
    const replay = yield* runReplayCursor({
      cursor: makeReplayCursor(entries, { scenario }),
      scenario,
      spawn: 1,
      name: "process #1",
      gate,
      failure,
      outbound,
      frameOf: (frame) => frame,
      state: () => state,
      deliver: (step) =>
        step.frame === "bad"
          ? Effect.fail(
              new ReplayInvalidInboundError({
                scenario,
                spawn: 1,
                cursor: step.cursor,
                reason: "bad frame",
                frame: step.frame,
              }),
            )
          : Queue.offer(delivered, step.frame).pipe(Effect.asVoid),
      finish: () =>
        Effect.sync(() => {
          state = "exited";
        }),
      onFail: (error) =>
        Effect.sync(() => {
          stops.push(error._tag);
          state = "failed";
        }),
    });
    return {
      replay,
      failure,
      stops,
      write: (frame: unknown) => Queue.offer(outbound, frame),
      delivered: Queue.take(delivered),
      deliveredCount: Queue.size(delivered),
      stop: () => {
        state = "stopped";
      },
    };
  });

describe("replay driver", () => {
  it.effect("delivers entries as their frames match and stops the transport on a failure", () =>
    Effect.gen(function* () {
      const transport = yield* makeTransport([
        { type: "expect_outbound", frame: { method: "start" } },
        { type: "emit_inbound", frame: "started" },
        { type: "emit_inbound", label: "broken", frame: "bad" },
        { type: "emit_inbound", frame: "never" },
      ]);
      yield* transport.write({ method: "start" });
      assert.equal(yield* transport.delivered, "started");

      const failure = yield* Deferred.await(transport.failure);
      assert.equal(failure._tag, "ReplayInvalidInboundError");
      assert.deepEqual(transport.stops, ["ReplayInvalidInboundError"]);
      assert.equal(yield* transport.deliveredCount, 0);
      assert.include(transport.replay.describePosition(), "failed with ReplayInvalidInboundError");
      // The first failure stays the one reported.
      yield* transport.replay.fail(
        new ReplayInvalidInboundError({
          scenario: "driver-unit",
          spawn: 1,
          cursor: 9,
          reason: "later",
          frame: null,
        }),
      );
      const reported = yield* Effect.flip(transport.replay.assertConsumed);
      assert.equal(reported._tag === "ReplayInvalidInboundError" && reported.reason, "bad frame");
    }).pipe(Effect.scoped),
  );

  it.effect("never delivers the entry it is parked at once the transport stops", () =>
    Effect.gen(function* () {
      const gate = yield* makeReplayGate(["delta"]);
      const transport = yield* makeTransport(
        [
          { type: "emit_inbound", label: "delta", frame: "delta" },
          { type: "expect_outbound", frame: { method: "close" } },
        ],
        gate,
      );
      yield* gate.reached("delta");
      assert.include(transport.replay.describePosition(), "parked at gate 'delta'");
      transport.stop();
      yield* gate.release("delta");

      // The replay goes on to match the frame with the parked entry still due, instead of
      // delivering it.
      yield* transport.write({ method: "close" });
      const outcome = yield* Effect.raceFirst(
        Deferred.await(transport.failure),
        transport.delivered.pipe(Effect.as({ _tag: "Delivered", message: "" } as const)),
      );
      assert.equal(outcome._tag, "ReplayUnexpectedOutboundError");
      assert.include(outcome.message, "delta is due first");
    }).pipe(Effect.scoped),
  );
});
