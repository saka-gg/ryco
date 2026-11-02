import {
  ThreadForkError,
  type ThreadForkKey,
  type ThreadForkResult,
  WS_METHODS,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { ThreadForkShape } from "../threadFork/Services/ThreadFork.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

/**
 * `threads.fork` and `threads.forkCarried`. Operator access is checked before anything is read,
 * decoded further or written: a carried conversation is only decoded by the fork service, after
 * this guard. The fork is admitted like every other mutation, once startup command readiness
 * allows it, so it never races startup recovery of worktrees, relocations or unfinished forks; it
 * then runs outside the startup queue, so a long fork never holds up commands queued behind it.
 */
export const makeThreadForkHandlers = (ctx: WsRpcContext) => {
  const service: Effect.Effect<ThreadForkShape, ThreadForkError> = Option.match(ctx.threadFork, {
    onNone: () =>
      Effect.fail(
        new ThreadForkError({
          reason: "unavailable",
          message: "Forking is unavailable on this server.",
          retryable: false,
          attempt: "none",
        }),
      ),
    onSome: Effect.succeed,
  });
  const guarded = (
    method: typeof WS_METHODS.threadsFork | typeof WS_METHODS.threadsForkCarried,
    forkKey: ThreadForkKey,
    run: (forks: ThreadForkShape) => Effect.Effect<ThreadForkResult, ThreadForkError>,
  ) =>
    observeRpcEffect(
      method,
      ctx.ownerEffect(
        method,
        service.pipe(
          Effect.flatMap((forks) =>
            ctx.enqueueStartupCommand(Effect.void).pipe(
              Effect.catchTag("ServerRuntimeStartupError", (error) =>
                // Refused before it ran; the key may still hold an attempt from before a restart.
                forks.attemptState(forkKey).pipe(
                  Effect.flatMap((attempt) =>
                    Effect.fail(
                      new ThreadForkError({
                        reason: "source-busy",
                        message: `The server is not ready to fork yet: ${error.message}`,
                        retryable: true,
                        attempt,
                      }),
                    ),
                  ),
                ),
              ),
              Effect.andThen(run(forks)),
            ),
          ),
        ),
      ),
      { "rpc.aggregate": "orchestration", "rpc.operation": "fork" },
    );
  return defineWsHandlers({
    [WS_METHODS.threadsFork]: (input) =>
      guarded(WS_METHODS.threadsFork, input.forkKey, (forks) => forks.fork(input)),
    [WS_METHODS.threadsForkCarried]: (input) =>
      guarded(WS_METHODS.threadsForkCarried, input.forkKey, (forks) => forks.forkCarried(input)),
  });
};
