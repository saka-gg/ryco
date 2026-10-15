import { WS_METHODS } from "@ryco/contracts";

import { readHostedRpcCapability } from "~/hostedHub/capabilities";

import { prefetchStatistics } from "../settings/statistics/useStatistics";
import type { StatisticsSearch } from "./statisticsSearch";
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
    case "usage":
      if (!readHostedRpcCapability(WS_METHODS.serverGetUsageSummary).allowed) return;
      prefetchUsageSummary(search.range, search.environmentIds);
      return;
    case "activity":
      if (!readHostedRpcCapability(WS_METHODS.serverGetStatistics).allowed) return;
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
