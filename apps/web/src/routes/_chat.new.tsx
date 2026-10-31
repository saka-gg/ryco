import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { getPresentationTier } from "../lib/presentationTier";

/** The keys a prompt link carries (`PROMPT_LINK_PARAM_KEYS` in `@ryco/shared/promptLinks`). */
const PROMPT_LINK_KEYS = ["prompt", "repo", "pr", "provider", "model"] as const;

export type PromptLinkRouteSearch = Partial<
  Record<(typeof PROMPT_LINK_KEYS)[number], string | undefined>
>;

/**
 * Only the link's own keys, as strings. The view parses the raw query instead
 * (`PromptLinkRouteView`): the router's search parsing reads `prompt=123` as a
 * number and `prompt="hi"` without its quotes, so its values are not the text.
 * The parser stays out of this file, which the boot bundle carries.
 */
function validatePromptLinkSearch(search: Record<string, unknown>): PromptLinkRouteSearch {
  const result: PromptLinkRouteSearch = {};
  for (const key of PROMPT_LINK_KEYS) {
    const value = search[key];
    if (typeof value === "string" || typeof value === "number") result[key] = String(value);
  }
  return result;
}

/**
 * `/new?prompt=…`: a prompt link. It opens a draft holding the prompt and never
 * sends it (`docs/user/prompt-links.md`).
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
