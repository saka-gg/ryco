import { Effect } from "effect";
import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { STATISTICS_STALE_WHILE_REVALIDATE_WAIT_MS } from "../statistics/StatisticsQuery.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeStatisticsHandlers = (ctx: WsRpcContext) => {
  const { statisticsQuery, usageService, ownerEffect } = ctx;

  return defineWsHandlers({
    // Owner-gated: the snapshot exposes every project's title and usage, so only
    // the owner session may read it (paired guests get an AuthRpcError).
    [WS_METHODS.serverGetStatistics]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverGetStatistics,
        ownerEffect(
          WS_METHODS.serverGetStatistics,
          // A reopen gets the previous snapshot at once when the refresh is slow; the
          // refresh keeps running, so the next request is current.
          statisticsQuery
            .getStatistics({ maxWaitMs: STATISTICS_STALE_WHILE_REVALIDATE_WAIT_MS })
            .pipe(Effect.orDie),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverGetUsageSummary]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverGetUsageSummary,
        ownerEffect(WS_METHODS.serverGetUsageSummary, usageService.readSummary(input)),
        { "rpc.aggregate": "server" },
      ),
  });
};
