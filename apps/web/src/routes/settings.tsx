import { createFileRoute, redirect } from "@tanstack/react-router";

import { ROUTE_PAGE_PENDING_MS, RoutePagePending } from "../components/routeViews/RoutePagePending";
import { getPresentationTier } from "../lib/presentationTier";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { preloadOpenSettingsSection, SettingsRouteComponent } from "../settingsRoute";

export const Route = createFileRoute("/settings")({
  // Section, device page tab and device, so Back, Forward and links open them.
  // Only short strings pass here; the page checks their values
  // (`parseSettingsLocationSearch`), so the section list stays out of boot.
  validateSearch: (search): { section?: string; device?: string; tab?: string } => {
    const pick = (value: unknown) =>
      typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
    const section = pick(search.section);
    const device = pick(search.device);
    const tab = pick(search.tab);
    return {
      ...(section ? { section } : {}),
      ...(device ? { device } : {}),
      ...(tab ? { tab } : {}),
    };
  },
  beforeLoad: ({ context, preload }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "hosted-hub"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    // The frozen phone tier presents settings as its own full-screen sheet over
    // the home stack, so the page itself never renders there. An intent
    // preload (hovering a link) must not open the sheet.
    if (getPresentationTier() === "phone") {
      if (!preload) useSettingsDialogStore.getState().markOpen();
      throw redirect({ to: "/", replace: true });
    }
  },
  // Route-level splitting: the router awaits the page chunk before it commits,
  // so a settings open never flashes an empty inset. `preloadSettingsPage`
  // warms the same component, so an earlier preload is not wasted.
  // The open section's body loads with the page, so it commits in one pass.
  loader: () => preloadOpenSettingsSection(),
  component: SettingsRouteComponent,
  pendingComponent: RoutePagePending,
  pendingMs: ROUTE_PAGE_PENDING_MS,
  pendingMinMs: 0,
});
