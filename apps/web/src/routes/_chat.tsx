import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "hosted-hub"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  // The router awaits this chunk before it commits the layout; the root
  // `beforeLoad` starts it with the auth round trips (`preloadMatchedRouteChunks`).
  component: lazyRouteComponent(
    () => import("../components/routeViews/ChatLayoutRouteView"),
    "ChatLayoutRoute",
  ),
});
