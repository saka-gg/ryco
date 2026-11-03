import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { PairingPendingSurface } from "../components/auth/PairingSurface";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "hosted-hub"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  // Route-level splitting: a launch that is already paired never downloads
  // the pairing form. The router awaits the chunk before it commits the page,
  // so the form renders without a Suspense fallback, and the root
  // `beforeLoad` starts the chunk with the session check. A chunk that fails
  // to load reloads the page once (`lazyRouteComponent`), then shows the root
  // error view.
  component: lazyRouteComponent(
    () => import("../components/routeViews/PairRouteView"),
    "PairRoute",
  ),
  pendingComponent: PairingPendingSurface,
});
