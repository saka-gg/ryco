import { Effect, Option } from "effect";
import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export function makeProviderSessionPrewarmHandlers(ctx: WsRpcContext) {
  return defineWsHandlers({
    [WS_METHODS.providerPrewarmSession]: (input) =>
      observeRpcEffect(
        WS_METHODS.providerPrewarmSession,
        ctx.ownerEffect(
          WS_METHODS.providerPrewarmSession,
          Option.match(ctx.sessionPrewarm, {
            onNone: () =>
              Effect.succeed({ status: "skipped" as const, reason: "prewarm unavailable" }),
            onSome: (prewarm) => prewarm.prewarm(input),
          }),
        ),
        { "rpc.aggregate": "provider" },
      ),
  });
}
