import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { parseTasksSearch } from "../components/tasks/tasksSearch";
import { getPresentationTier } from "../lib/presentationTier";
import { requireAppSession } from "../routeAuthGate";

export const Route = createFileRoute("/tasks")({
  beforeLoad: ({ context }) => {
    // The web phone tier is frozen and has no Tasks page.
    if (getPresentationTier() === "phone") {
      throw redirect({ to: "/", replace: true });
    }
    requireAppSession(context);
  },
  validateSearch: (search) => parseTasksSearch(search),
  // Route-level splitting: the router awaits the page chunk before it commits,
  // so the page renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/TasksRouteView"),
    "TasksRoute",
  ),
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
