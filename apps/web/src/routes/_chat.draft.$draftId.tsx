import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { parseRightPanelRouteSearch } from "../rightPanelRouteSearch";

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseRightPanelRouteSearch(search),
  // Route-level splitting: the router awaits this chunk before it commits the
  // match, so the draft view renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/DraftChatThreadRouteView"),
    "DraftChatThreadRoute",
  ),
  // A deep-linked document shows the shell with a blank pane instead of
  // waiting for the whole thread graph; quick switches keep the old view.
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
