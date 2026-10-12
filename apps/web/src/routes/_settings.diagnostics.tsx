import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";

export const Route = createFileRoute("/_settings/diagnostics")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  // Route-level splitting: the router awaits the page chunk (including the
  // diagnostics panel) before it commits, so the page renders in one pass.
  component: lazyRouteComponent(
    () => import("../components/routeViews/DiagnosticsRouteView"),
    "DiagnosticsRoute",
  ),
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
