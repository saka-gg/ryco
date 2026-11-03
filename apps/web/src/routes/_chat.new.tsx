import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { getPresentationTier } from "../lib/presentationTier";
import { validatePromptLinkSearch } from "../lib/routerSearch";

/**
 * `/new?prompt=…`: a prompt link. It opens a draft holding the prompt and never
 * sends it (`docs/user/prompt-links.md`). The router reads the link's keys as
 * the text they are (`lib/routerSearch.ts`); the parser stays out of this file,
 * which the boot bundle carries.
 */
export const Route = createFileRoute("/_chat/new")({
  beforeLoad: () => {
    // The web phone tier is frozen; the native app opens prompt links.
    if (getPresentationTier() === "phone") {
      throw redirect({ to: "/", replace: true });
    }
  },
  validateSearch: validatePromptLinkSearch,
  component: lazyRouteComponent(
    () => import("../components/routeViews/PromptLinkRouteView"),
    "PromptLinkRoute",
  ),
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
