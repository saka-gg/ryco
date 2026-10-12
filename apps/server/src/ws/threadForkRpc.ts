import { ThreadForkError, WS_METHODS } from "@ryco/contracts";
import { Effect, Option } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { ThreadForkShape } from "../threadFork/Services/ThreadFork.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

/**
 * `threads.fork`. Operator access is checked before anything is read or written. The fork is
 * admitted like every other mutation, once startup command readiness allows it, so it never
 * races startup recovery of worktrees, relocations or unfinished forks; it then runs outside the
 * startup queue, so a long fork never holds up commands queued behind it.
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
  return defineWsHandlers({
    [WS_METHODS.threadsFork]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadsFork,
        ctx.ownerEffect(
          WS_METHODS.threadsFork,
          service.pipe(
            Effect.flatMap((forks) =>
              ctx.enqueueStartupCommand(Effect.void).pipe(
                Effect.catchTag("ServerRuntimeStartupError", (error) =>
                  // Refused before it ran; the key may still hold an attempt from before a restart.
                  forks.attemptState(input.forkKey).pipe(
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
                Effect.andThen(forks.fork(input)),
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "orchestration", "rpc.operation": "fork" },
      ),
  });
};
