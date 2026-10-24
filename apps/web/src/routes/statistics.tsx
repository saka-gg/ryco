import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import {
  parseStatisticsSearch,
  type StatisticsSearch,
} from "../components/statistics/statisticsSearch";
import { getPresentationTier } from "../lib/presentationTier";

export const Route = createFileRoute("/statistics")({
  beforeLoad: ({ context }) => {
    if (getPresentationTier() === "phone") {
      throw redirect({ to: "/", replace: true });
    }
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "hosted-hub"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: (search) => parseStatisticsSearch(search),
  // The page's requests start with the navigation (and on link intent), in
  // parallel with its chunk; the page joins them. Never awaited, and imported
  // on demand so no statistics code enters the boot graph.
  //
  // On the mounted page only a change it would not request by itself reruns
  // the loader: another view, or another usage range. The activity snapshot
  // and today's recap ignore the range, and the usage and today views ask a
  // newly selected environment themselves, so rerunning on those would only
  // start requests nobody joins.
  loaderDeps: ({ search }) => {
    // `search` is the validated search above. The assertion breaks the same
    // declaration inference cycle as the route view's.
    const { view, range } = search as StatisticsSearch;
    return view === "usage" ? { view, range } : { view };
  },
  loader: ({ location }) => {
    // The search of the location being entered or preloaded (deps only decide when this runs).
    const search = parseStatisticsSearch(location.search);
    // Best effort: the page reports its own failures.
    void import("../components/statistics/statisticsPrefetch")
      .then(({ prefetchStatisticsPage }) => prefetchStatisticsPage(search))
      .catch(() => undefined);
  },
  // Route-level splitting: the router awaits the page chunk (warmed on link
  // intent) before it commits, so the page renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/StatisticsRouteView"),
    "StatisticsRoute",
  ),
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
