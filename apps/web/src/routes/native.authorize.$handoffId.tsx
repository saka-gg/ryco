import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { AppBootLoadingSurface } from "../components/AppBootLoadingSurface";
import { isHostedHubMode } from "../env";

export const Route = createFileRoute("/native/authorize/$handoffId")({
  // A signed-out browser shows the hosted sign-in first: its chunk loads with
  // the route body's, so it renders on the first pass. A failed load is
  // reported by the surface's own mount.
  loader: () =>
    isHostedHubMode()
      ? import("../components/routeViews/NativeAuthorizationRouteView").then(
          (module) => module.preloadNativeAuthorizationSurface(),
          () => undefined,
        )
      : undefined,
  // Route-level splitting: the router awaits the consent chunk before it
  // commits, so the handoff renders without a Suspense fallback.
  component: lazyRouteComponent(
    () => import("../components/routeViews/NativeAuthorizationRouteView"),
    "NativeAuthorizationRoute",
  ),
  pendingComponent: AppBootLoadingSurface,
});
