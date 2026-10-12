import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import {
  parsePullRequestsSearch,
  type PullRequestsSearch,
} from "../components/pullRequests/pullRequestsSearch";
import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { getPresentationTier } from "../lib/presentationTier";

export const Route = createFileRoute("/pull-requests")({
  beforeLoad: ({ context }) => {
    // The web phone tier is frozen; pull requests live in the native app there.
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
  validateSearch: (search) => parsePullRequestsSearch(search),
  // The page's list reads start with the navigation, in parallel with the page
  // chunk, instead of after the page mounts. The prefetch module loads on
  // demand so the list data layer stays out of the boot graph; hover (intent)
  // preloads only warm the chunk, so sweeping across links runs no lists.
  loaderDeps: ({ search }: { readonly search: PullRequestsSearch }) => ({
    env: search.env,
    project: search.project,
    state: search.state,
  }),
  loader: ({ deps, cause }) => {
    // Only entering the page: once it is mounted its own list watches run,
    // and a re-run on every in-page navigation (selecting a pull request,
    // changing a filter) would re-arm the lists' poll timers each time,
    // postponing their polls while someone steps through the list.
    if (cause !== "enter") return;
    void import("../components/pullRequests/prefetchPullRequestLists")
      .then(({ prefetchPullRequestLists }) => prefetchPullRequestLists(deps))
      .catch(() => undefined);
  },
  // A hover-preloaded match must not stand in for the navigation's own loader
  // run (that would skip the prefetch); the chunk stays warm either way.
  preloadStaleTime: 0,
  // Route-level splitting: the router awaits the page chunk before it commits,
  // so the page renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/PullRequestsRouteView"),
    "PullRequestsRoute",
  ),
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
