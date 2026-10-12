import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { AppBootLoadingSurface } from "../components/AppBootLoadingSurface";

export const Route = createFileRoute("/native/authorize/$handoffId")({
  // Route-level splitting: the router awaits the consent chunk before it
  // commits, so the handoff renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/NativeAuthorizationRouteView"),
    "NativeAuthorizationRoute",
  ),
  pendingComponent: AppBootLoadingSurface,
});
