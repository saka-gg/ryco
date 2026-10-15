import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { loadChatRouteView } from "../components/shell/phone/lazyPhoneThreadSurfaces";
import { parseRightPanelRouteSearch } from "../rightPanelRouteSearch";
import {
  prewarmThreadDetailSubscription,
  releaseThreadDetailPrewarmsExcept,
} from "../lib/threadDetailPrewarm";
import { resolveThreadRouteRef } from "../threadRoutes";

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseRightPanelRouteSearch(search),
  // The thread window request starts with the navigation, in parallel with the
  // route chunk, instead of after the view mounts: the loader retains the
  // subscription synchronously. The view releases that retain once ChatView
  // holds its own; the lifecycle hooks below drop it when the route settles
  // elsewhere. Hover (intent) preloads only warm the chunk, so sweeping across
  // thread links opens no streams.
  loader: ({ params, preload }) => {
    if (preload) return;
    const threadRef = resolveThreadRouteRef(params);
    if (threadRef) prewarmThreadDetailSubscription(threadRef.environmentId, threadRef.threadId);
  },
  onEnter: (match) => releaseThreadDetailPrewarmsExcept(resolveThreadRouteRef(match.params)),
  onStay: (match) => releaseThreadDetailPrewarmsExcept(resolveThreadRouteRef(match.params)),
  onLeave: () => releaseThreadDetailPrewarmsExcept(null),
  // A hover-preloaded match must not stand in for the navigation's own loader
  // run (that would skip the prewarm); the chunk stays warm either way.
  preloadStaleTime: 0,
  // Route-level splitting: the router awaits this chunk before it commits the
  // match, so the view renders without a Suspense fallback (and without
  // React's 300 ms fallback-reveal throttle).
  // On the phone tier that includes the phone thread surfaces chunk, so the
  // app bar and dock are there in the first frame.
  component: lazyRouteComponent(
    () => loadChatRouteView(() => import("../components/routeViews/ChatThreadRouteView")),
    "ChatThreadRoute",
  ),
  // A deep-linked document shows the shell with a blank pane instead of
  // waiting for the whole thread graph; quick switches keep the old view.
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
