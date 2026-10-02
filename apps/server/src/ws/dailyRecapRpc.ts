import { Effect, Option } from "effect";
import { DailyRecapReadError, WS_METHODS } from "@ryco/contracts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export function makeDailyRecapHandlers(ctx: WsRpcContext) {
  return defineWsHandlers({
    [WS_METHODS.serverGetDailyRecap]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.serverGetDailyRecap,
        Option.match(ctx.dailyRecapQuery, {
          onNone: () =>
            Effect.fail(
              new DailyRecapReadError({
                reason: "query-failed",
                detail: "Daily recaps are unavailable on this node.",
              }),
            ),
          onSome: (query) => query.getDailyRecap(input),
        }),
      ),
  });
}
