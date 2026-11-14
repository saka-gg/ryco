/**
 * Runs a Copilot session's SDK callbacks (session events, approval and user-input notices) as
 * Effects without detaching them: one fiber in the session's scope takes them in the order the SDK
 * delivered them, logs a failure instead of dropping it, and stops with the session.
 *
 * @module provider/Layers/CopilotAdapter.callbacks
 */
import type { ThreadId } from "@ryco/contracts";
import { Cause, Duration, Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";

/** How long a stopping session waits for callbacks queued before the stop. */
export const COPILOT_CALLBACK_DRAIN_TIMEOUT_MS = 2_000;

export interface CopilotSessionCallbacks {
  /**
   * Queues `work` behind every callback queued before it. Returns false once the session closed;
   * the work is then dropped.
   */
  readonly run: (work: Effect.Effect<void>) => boolean;
  /**
   * Queues a fork of `work` into the session scope (for timers): it runs concurrently with later
   * callbacks and is interrupted when the session closes.
   */
  readonly fork: (work: Effect.Effect<void>) => boolean;
  /**
   * Stops accepting work, lets already-queued callbacks finish within `drainTimeoutMs`, then
   * closes the session scope (interrupting what is left, forks included).
   */
  readonly close: Effect.Effect<void>;
}

export const makeCopilotSessionCallbacks = (input: {
  readonly parentScope: Scope.Scope;
  readonly threadId: ThreadId;
  readonly drainTimeoutMs?: number;
}): Effect.Effect<CopilotSessionCallbacks> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(input.parentScope, "parallel");
    const queue = yield* Queue.unbounded<Effect.Effect<void>, Cause.Done>();
    const logged = (work: Effect.Effect<void>): Effect.Effect<void> =>
      work.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("GitHub Copilot session callback failed", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    const drain = yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach(logged),
      Effect.forkIn(scope),
    );
    return {
      run: (work) => Queue.offerUnsafe(queue, work),
      fork: (work) =>
        Queue.offerUnsafe(queue, logged(work).pipe(Effect.forkIn(scope), Effect.asVoid)),
      close: Effect.suspend(() => {
        Queue.endUnsafe(queue);
        return Fiber.await(drain).pipe(
          Effect.timeoutOption(
            Duration.millis(input.drainTimeoutMs ?? COPILOT_CALLBACK_DRAIN_TIMEOUT_MS),
          ),
          Effect.tap((drained) =>
            drained._tag === "None"
              ? Effect.logWarning("GitHub Copilot session stopped with callbacks still queued", {
                  threadId: input.threadId,
                })
              : Effect.void,
          ),
          Effect.andThen(Scope.close(scope, Exit.void)),
        );
      }),
    } satisfies CopilotSessionCallbacks;
  });
