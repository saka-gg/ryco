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
  if (search.view === "usage") {
    if (!readHostedRpcCapability(WS_METHODS.serverGetUsageSummary).allowed) return;
    prefetchUsageSummary(search.range, search.environmentIds);
    return;
  }
  if (!readHostedRpcCapability(WS_METHODS.serverGetStatistics).allowed) return;
  prefetchStatistics();
}
