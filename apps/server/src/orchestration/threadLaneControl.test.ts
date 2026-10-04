import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ThreadId, TurnId } from "@ryco/contracts";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import { describe } from "vite-plus/test";

import {
  makeThreadLaneControl,
  ProviderSessionStartCancelledError,
  type ProviderIntentEvent,
  type StartKind,
} from "./threadLaneControl.ts";

const threadId = ThreadId.make("thread-1");
const createdAt = "2026-10-04T00:00:00.000Z";

const base = (sequence: number, commandId: string | null) => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: createdAt,
  commandId: commandId === null ? null : CommandId.make(commandId),
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const interrupt = (
  sequence: number,
  options: { readonly turnId?: string; readonly commandId?: string } = {},
): ProviderIntentEvent => ({
  ...base(sequence, options.commandId ?? `client:interrupt-${sequence}`),
  type: "thread.turn-interrupt-requested",
  payload: {
    threadId,
    ...(options.turnId ? { turnId: TurnId.make(options.turnId) } : {}),
    createdAt,
  },
});

const sessionStop = (sequence: number): ProviderIntentEvent => ({
  ...base(sequence, `client:stop-${sequence}`),
  type: "thread.session-stop-requested",
  payload: { threadId, createdAt },
});

const at = (fenceSequence: number, kind: StartKind) => ({ threadId, fenceSequence, kind });

describe("threadLaneControl fence", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly event: ProviderIntentEvent;
    readonly turn: boolean;
    readonly restart: boolean;
  }> = [
    { name: "session stop", event: sessionStop(10), turn: true, restart: true },
    { name: "user interrupt without turn id", event: interrupt(10), turn: true, restart: true },
    {
      name: "user interrupt with turn id",
      event: interrupt(10, { turnId: "turn-1" }),
      turn: false,
      restart: true,
    },
    {
      name: "provider-originated interrupt",
      event: interrupt(10, { commandId: "provider:abort" }),
      turn: false,
      restart: false,
    },
  ];
  for (const testCase of cases) {
    it.effect(`${testCase.name} cancels lower starts only`, () =>
      Effect.gen(function* () {
        const control = yield* makeThreadLaneControl;
        yield* control.noteEvent(testCase.event);
        assert.equal(yield* control.cancelsStart(at(5, "turn")), testCase.turn);
        assert.equal(yield* control.cancelsStart(at(5, "restart")), testCase.restart);
        // Items committed after the stop are never cancelled by it.
        assert.isFalse(yield* control.cancelsStart(at(11, "turn")));
        assert.isFalse(yield* control.cancelsStart(at(11, "restart")));
        // Other threads are unaffected.
        assert.isFalse(
          yield* control.cancelsStart({
            threadId: ThreadId.make("thread-2"),
            fenceSequence: 5,
            kind: "restart",
          }),
        );
      }),
    );
  }

  it.effect("guardStart fails at once when a stop was already noted and records it", () =>
    Effect.gen(function* () {
      const control = yield* makeThreadLaneControl;
      const stop = sessionStop(10);
      yield* control.noteEvent(stop);
      let ran = false;
      const error = yield* control
        .guardStart(
          at(4, "turn"),
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderSessionStartCancelledError);
      assert.equal(error.stopSequence, 10);
      assert.isFalse(ran);
      assert.isTrue(yield* control.cancelledAStart(threadId, stop.eventId));
      // Consumed.
      assert.isFalse(yield* control.cancelledAStart(threadId, stop.eventId));
    }),
  );

  it.effect("a later stop cancels an in-flight guarded start", () =>
    Effect.gen(function* () {
      const control = yield* makeThreadLaneControl;
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const guarded = yield* control
        .guardStart(
          at(4, "turn"),
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const stop = interrupt(9);
      yield* control.noteEvent(stop);
      const exit = yield* Fiber.await(guarded);
      assert.isTrue(Exit.isFailure(exit));
      const error = yield* Fiber.join(guarded).pipe(Effect.flip);
      assert.instanceOf(error, ProviderSessionStartCancelledError);
      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.isTrue(yield* control.cancelledAStart(threadId, stop.eventId));
    }),
  );

  it.effect(
    "an interrupt with a turn id cancels a running restart but not a running turn start",
    () =>
      Effect.gen(function* () {
        const control = yield* makeThreadLaneControl;
        const turnStart = yield* control
          .guardStart(at(4, "turn"), Effect.never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* control.noteEvent(interrupt(9, { turnId: "turn-1" }));
        yield* Effect.yieldNow;
        assert.isUndefined(turnStart.pollUnsafe());
        yield* Fiber.interrupt(turnStart);

        const restart = yield* control
          .guardStart(at(12, "restart"), Effect.never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* control.noteEvent(interrupt(13, { turnId: "turn-1" }));
        const error = yield* Fiber.join(restart).pipe(Effect.flip);
        assert.instanceOf(error, ProviderSessionStartCancelledError);
      }),
  );

  it.effect("noting a stop between registration steps never misses it", () =>
    Effect.gen(function* () {
      const control = yield* makeThreadLaneControl;
      for (let round = 0; round < 50; round += 1) {
        const fence = round * 10 + 1;
        const guarded = yield* control
          .guardStart(at(fence, "turn"), Effect.yieldNow.pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild);
        if (round % 2 === 0) yield* Effect.yieldNow;
        yield* control.noteEvent(sessionStop(fence + 1));
        const error = yield* Fiber.join(guarded).pipe(Effect.flip);
        assert.instanceOf(error, ProviderSessionStartCancelledError);
      }
    }),
  );
});

describe("threadLaneControl turn ownership", () => {
  it.effect("refuses ownership after a user stop past the fence", () =>
    Effect.gen(function* () {
      const control = yield* makeThreadLaneControl;
      yield* control.noteEvent(interrupt(8, { turnId: "turn-1" }));
      const error = yield* control.beginTurnOwnership(threadId, 5).pipe(Effect.flip);
      assert.instanceOf(error, ProviderSessionStartCancelledError);
      assert.isTrue(yield* control.stopRequestedSince(threadId, 5));
      // An older stop does not block a later handoff.
      yield* control.beginTurnOwnership(threadId, 9);
      yield* control.endTurnOwnership(threadId);
    }),
  );

  it.effect("routes a stop noted during ownership out of band", () =>
    Effect.gen(function* () {
      const control = yield* makeThreadLaneControl;
      yield* control.beginTurnOwnership(threadId, 5);
      assert.isFalse(yield* control.stopRequestedSince(threadId, 5));
      const stop = interrupt(9);
      assert.deepEqual(yield* control.noteEvent(stop), { outOfBand: true });
      assert.isTrue(yield* control.stopRequestedSince(threadId, 5));
      const outcome = yield* control.registerOutOfBand(threadId, stop.eventId);
      const taken = yield* control.takeOutOfBand(threadId, stop.eventId);
      assert.isTrue(Option.isSome(taken) && taken.value === outcome);
      assert.isTrue(Option.isNone(yield* control.takeOutOfBand(threadId, stop.eventId)));
      // Provider-originated interrupts are never routed out of band.
      assert.deepEqual(yield* control.noteEvent(interrupt(10, { commandId: "provider:x" })), {
        outOfBand: false,
      });
      yield* control.endTurnOwnership(threadId);
      assert.deepEqual(yield* control.noteEvent(interrupt(11)), { outOfBand: false });
    }),
  );
});

describe("threadLaneControl prune", () => {
  it.effect("drops idle state and keeps state that is still in flight", () =>
    Effect.gen(function* () {
      const control = yield* makeThreadLaneControl;
      yield* control.noteEvent(sessionStop(10));
      // Not yet processed through the stop: kept.
      yield* control.prune(threadId, 9);
      assert.isTrue(yield* control.cancelsStart(at(5, "turn")));
      yield* control.prune(threadId, 10);
      assert.isFalse(yield* control.cancelsStart(at(5, "turn")));

      // An owner keeps the state.
      yield* control.beginTurnOwnership(threadId, 20);
      yield* control.noteEvent(interrupt(21));
      yield* control.prune(threadId, 30);
      assert.isTrue(yield* control.stopRequestedSince(threadId, 20));
      yield* control.endTurnOwnership(threadId);

      // A pending out-of-band outcome keeps the state.
      const outOfBand = interrupt(31);
      yield* control.registerOutOfBand(threadId, outOfBand.eventId);
      yield* control.prune(threadId, 40);
      assert.isTrue(yield* control.stopRequestedSince(threadId, 20));
      yield* control.takeOutOfBand(threadId, outOfBand.eventId);
      yield* control.prune(threadId, 40);
      assert.isFalse(yield* control.stopRequestedSince(threadId, 20));
    }),
  );
});
