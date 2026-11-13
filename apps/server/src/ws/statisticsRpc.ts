import { Effect } from "effect";
import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { STATISTICS_STALE_WHILE_REVALIDATE_WAIT_MS } from "../statistics/StatisticsQuery.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

/**
 * How long a whole-machine request waits for the session-file read: long enough for a read
 * whose files are cached, short enough that a cold read answers at once with its progress (the
 * client asks again until it is done).
 */
const MACHINE_STATISTICS_WAIT_MS = 1_500;

export const makeStatisticsHandlers = (ctx: WsRpcContext) => {
  const { statisticsQuery, usageService, ownerEffect } = ctx;

  return defineWsHandlers({
    // Owner-gated: the snapshot exposes every project's title and usage, so only
    // the owner session may read it (paired guests get an AuthRpcError).
    [WS_METHODS.serverGetStatistics]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverGetStatistics,
        ownerEffect(
          WS_METHODS.serverGetStatistics,
          // A reopen gets the previous snapshot at once when the refresh is slow; the
          // refresh keeps running, so the next request is current. Costs come from the
          // usage price list, so both views price a model alike, session-file usage included.
          statisticsQuery
            .getStatistics({ maxWaitMs: STATISTICS_STALE_WHILE_REVALIDATE_WAIT_MS })
            .pipe(
              Effect.orDie,
              Effect.flatMap((snapshot) =>
                input.scope === "machine"
                  ? statisticsQuery.getMachineAttribution().pipe(
                      Effect.orDie,
                      Effect.flatMap((attribution) =>
                        usageService.machineStatistics(snapshot, {
                          ...attribution,
                          maxWaitMs: MACHINE_STATISTICS_WAIT_MS,
                        }),
                      ),
                    )
                  : Effect.succeed(snapshot),
              ),
              Effect.flatMap(usageService.priceStatistics),
            ),
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
