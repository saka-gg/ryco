import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { parseProjectsSearch } from "../components/projects/projectsSearch";
import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { getPresentationTier } from "../lib/presentationTier";

export const Route = createFileRoute("/projects")({
  beforeLoad: ({ context }) => {
    // The web phone tier is frozen; it keeps the project dialogs instead.
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
  validateSearch: (search) => parseProjectsSearch(search),
  // Route-level splitting: the router awaits the page chunk before it commits,
  // so the page renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/ProjectsRouteView"),
    "ProjectsRoute",
  ),
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
