import { getRouteApi } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { StatisticsPage } from "../statistics/StatisticsPage";
import type { StatisticsSearch } from "../statistics/statisticsSearch";

const statisticsRouteApi = getRouteApi("/statistics");

/** The `/statistics` route body, loaded by the route file through `lazyRouteComponent`. */
export function StatisticsRoute(): ReactElement {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the lazy component/Route declaration inference cycle.
  const search = statisticsRouteApi.useSearch() as StatisticsSearch;
  const navigate = statisticsRouteApi.useNavigate();
  return (
    <StatisticsPage
      search={search}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
