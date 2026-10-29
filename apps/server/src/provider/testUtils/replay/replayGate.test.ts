import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";

import { makeReplayGate } from "./replayGate.ts";

describe("replay gate", () => {
  it.effect("parks at a gated label until released, and never parks elsewhere", () =>
    Effect.gen(function* () {
      const gate = yield* makeReplayGate(["delta-2"]);
      yield* gate.beforeEmit("delta-1");
      yield* gate.beforeEmit(undefined);

      const parked = yield* gate.beforeEmit("delta-2").pipe(Effect.forkChild);
      yield* gate.reached("delta-2");
      assert.isUndefined(parked.pollUnsafe());

      assert.isTrue(yield* gate.release("delta-2"));
      yield* Fiber.join(parked);
      assert.isFalse(yield* gate.release("delta-2"));
      // Released labels stay open.
      yield* gate.beforeEmit("delta-2");
    }),
  );

  it.effect("releaseAll frees every parked emit", () =>
    Effect.gen(function* () {
      const gate = yield* makeReplayGate(["a", "b"]);
      const first = yield* gate.beforeEmit("a").pipe(Effect.forkChild);
      const second = yield* gate.beforeEmit("b").pipe(Effect.forkChild);
      yield* gate.reached("a");
      yield* gate.reached("b");

      yield* gate.releaseAll;
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(first)));
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(second)));
      assert.isFalse(yield* gate.release("a"));
    }),
  );

  it.effect("rejects duplicate and unknown labels as defects", () =>
    Effect.gen(function* () {
      const duplicate = yield* Effect.exit(makeReplayGate(["a", "a"]));
      assert.isTrue(Exit.hasDies(duplicate));

      const gate = yield* makeReplayGate(["a"]);
      assert.isTrue(Exit.hasDies(yield* Effect.exit(gate.reached("missing"))));
      assert.isTrue(Exit.hasDies(yield* Effect.exit(gate.release("missing"))));
    }),
  );
});
