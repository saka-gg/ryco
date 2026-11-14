import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { requireAppSession } from "../routeAuthGate";

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    requireAppSession(context);
  },
  // The router awaits this chunk before it commits the layout; the root
  // `beforeLoad` starts it with the auth round trips (`preloadMatchedRouteChunks`).
  component: lazyRouteComponent(
    () => import("../components/routeViews/ChatLayoutRouteView"),
    "ChatLayoutRoute",
  ),
});
