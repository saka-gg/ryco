import { WS_METHODS } from "@ryco/contracts";

import { readHostedRpcCapability } from "~/hostedHub/capabilities";

import { prefetchStatistics } from "../settings/statistics/useStatistics";
import type { StatisticsSearch } from "./statisticsSearch";
import { prefetchDailyRecap, TODAY_USAGE_RANGE } from "./today/useDailyRecap";
import { prefetchUsageSummary } from "./useUsageSummary";

/** The part of the page's search that decides which requests it makes. */
export type StatisticsPrefetchSearch = Pick<StatisticsSearch, "view" | "range" | "environmentIds">;

/**
 * Start the requests the Statistics page will make for `search`, in parallel
 * with its chunk (the route loader runs on navigation and on link intent). The
 * page's own requests join them. A session the page would refuse asks nothing.
 */
export function prefetchStatisticsPage(search: StatisticsPrefetchSearch): void {
  switch (search.view) {
    case "today":
      // hosted-capability: routed node
      if (!readHostedRpcCapability(WS_METHODS.serverGetDailyRecap, null).allowed) return;
      prefetchDailyRecap(search.environmentIds);
      // Its provider usage sentence and tile, where the session may read usage.
      // hosted-capability: routed node
      if (readHostedRpcCapability(WS_METHODS.serverGetUsageSummary, null).allowed) {
        prefetchUsageSummary(TODAY_USAGE_RANGE, search.environmentIds);
      }
      return;
    case "usage":
      // hosted-capability: routed node
      if (!readHostedRpcCapability(WS_METHODS.serverGetUsageSummary, null).allowed) return;
      prefetchUsageSummary(search.range, search.environmentIds);
      return;
    case "activity":
      // hosted-capability: routed node
      if (!readHostedRpcCapability(WS_METHODS.serverGetStatistics, null).allowed) return;
      prefetchStatistics();
      return;
    case "limits":
      // The Limits view reads provider limits itself and never shows the
      // activity snapshot, so there is nothing of it to start here.
      return;
    default: {
      const unhandled: never = search.view;
      return unhandled;
    }
  }
}
