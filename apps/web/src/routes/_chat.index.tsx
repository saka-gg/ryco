import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { getPresentationTier } from "../lib/presentationTier";

export const Route = createFileRoute("/_chat/")({
  // The phone tier's Home renders on the first pass: its chunk loads with the
  // route body's. A failed load is reported by the component's own import.
  loader: () =>
    getPresentationTier() === "phone"
      ? import("../components/routeViews/ChatIndexRouteView").then(
          (module) => module.preloadPhoneHome(),
          () => undefined,
        )
      : undefined,
  component: lazyRouteComponent(
    () => import("../components/routeViews/ChatIndexRouteView"),
    "ChatIndexRoute",
  ),
});
