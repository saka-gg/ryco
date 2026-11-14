import { assert, it } from "@effect/vitest";
import { ThreadId } from "@ryco/contracts";
import { Deferred, Effect, Exit, Fiber, Logger, Scope } from "effect";

import { makeCopilotSessionCallbacks } from "./CopilotAdapter.callbacks.ts";

const threadId = ThreadId.make("thread-copilot-callbacks");

const withCallbacks = Effect.gen(function* () {
  const parentScope = yield* Scope.make();
  const callbacks = yield* makeCopilotSessionCallbacks({
    parentScope,
    threadId,
    drainTimeoutMs: 1_000,
  });
  return { parentScope, callbacks };
});

it.effect("runs queued callbacks one at a time in queue order", () =>
  Effect.gen(function* () {
    const { callbacks } = yield* withCallbacks;
    const seen: Array<string> = [];
    const gate = yield* Deferred.make<void>();
    // The first callback suspends; the second must still wait for it.
    callbacks.run(Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => seen.push("first")))));
    callbacks.run(Effect.sync(() => seen.push("second")));
    yield* Effect.yieldNow;
    assert.deepStrictEqual(seen, []);
    yield* Deferred.succeed(gate, undefined);
    yield* callbacks.close;
    assert.deepStrictEqual(seen, ["first", "second"]);
  }),
);

it.effect("logs a failed callback, defects included, and keeps running later ones", () =>
  Effect.gen(function* () {
    const logged: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      logged.push(JSON.stringify(message));
    });
    const seen: Array<string> = [];
    yield* Effect.gen(function* () {
      const { callbacks } = yield* withCallbacks;
      callbacks.run(Effect.die(new Error("emit without a runtime session")));
      callbacks.run(Effect.fail("typed") as never);
      callbacks.run(Effect.sync(() => seen.push("after")));
      yield* callbacks.close;
    }).pipe(Effect.provide(Logger.layer([logger])));
    assert.deepStrictEqual(seen, ["after"]);
    const failures = logged.filter((line) =>
      line.includes("GitHub Copilot session callback failed"),
    );
    assert.equal(failures.length, 2);
    assert.include(failures[0], "emit without a runtime session");
    assert.include(failures[0], threadId);
  }),
);

it.effect("close lets queued callbacks finish, interrupts forks and refuses new work", () =>
  Effect.gen(function* () {
    const { callbacks } = yield* withCallbacks;
    const forkInterrupted = yield* Deferred.make<void>();
    const forkStarted = yield* Deferred.make<void>();
    callbacks.fork(
      Deferred.succeed(forkStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(forkInterrupted, undefined)),
      ),
    );
    yield* Deferred.await(forkStarted);
    let queuedRan = false;
    const gate = yield* Deferred.make<void>();
    callbacks.run(Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => (queuedRan = true)))));
    const closing = yield* callbacks.close.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.isFalse(queuedRan);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(closing);
    assert.isTrue(queuedRan);
    yield* Deferred.await(forkInterrupted);
    assert.isFalse(callbacks.run(Effect.void));
  }),
);

it.effect("closing the parent scope interrupts the session's callbacks", () =>
  Effect.gen(function* () {
    const { parentScope, callbacks } = yield* withCallbacks;
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    callbacks.run(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
    );
    yield* Deferred.await(started);
    yield* Scope.close(parentScope, Exit.void);
    yield* Deferred.await(interrupted);
  }),
);
