import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { usePresentationTier } from "../hooks/usePresentationTier";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { preloadSettingsPage, SETTINGS_ROUTE_PATH } from "../settingsRoute";
import { resolveThreadRouteRef } from "../threadRoutes";

/**
 * Keeps the settings store's `open` flag and the `/settings` route in step on
 * every tier that presents settings as a page.
 *
 * - `openSettings(...)` from anywhere navigates to the page.
 * - Leaving the page by any route change closes settings.
 * - `closeSettings()` while the page is showing leaves it, unless the caller is
 *   already navigating somewhere else in the same tick.
 *
 * The phone tier keeps its sheet and never routes, so the bridge stands down
 * there. Arriving by URL is handled by the route itself (`markOpen`).
 *
 * The page has no thread in its URL, so the thread being viewed when settings
 * open is captured as the device target — the dialog used to read it from the
 * route it floated over.
 */
export function SettingsRouteBridge() {
  const router = useRouter();
  const pageTier = usePresentationTier() !== "phone";
  const open = useSettingsDialogStore((state) => state.open);
  const onSettingsRoute = useLocation({
    select: (location) => location.pathname === SETTINGS_ROUTE_PATH,
  });

  useEffect(() => {
    if (!pageTier) return;
    const handle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(preloadSettingsPage, { timeout: 4_000 })
        : window.setTimeout(preloadSettingsPage, 1_500);
    return () => {
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [pageTier]);

  const routedEnvironmentId = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params)?.environmentId ?? null,
  });
  const routedEnvironmentRef = useRef(routedEnvironmentId);
  useEffect(() => {
    routedEnvironmentRef.current = routedEnvironmentId;
  }, [routedEnvironmentId]);

  useEffect(() => {
    if (!pageTier || !open) return;
    if (router.latestLocation.pathname === SETTINGS_ROUTE_PATH) return;
    const state = useSettingsDialogStore.getState();
    if (state.targetEnvironmentId === null && routedEnvironmentRef.current !== null) {
      useSettingsDialogStore.setState({ targetEnvironmentId: routedEnvironmentRef.current });
    }
    void router.navigate({ to: SETTINGS_ROUTE_PATH });
  }, [open, pageTier, router]);

  const wasOnSettingsRoute = useRef(onSettingsRoute);
  useEffect(() => {
    const was = wasOnSettingsRoute.current;
    wasOnSettingsRoute.current = onSettingsRoute;
    if (!pageTier || !was || onSettingsRoute) return;
    const state = useSettingsDialogStore.getState();
    if (state.open) state.closeSettings();
  }, [onSettingsRoute, pageTier]);

  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!pageTier || !closed) return;
    // Deferred so a caller that closes settings and navigates in the same
    // handler (Statistics, Hub account) wins instead of being sent back.
    const timer = window.setTimeout(() => {
      if (useSettingsDialogStore.getState().open) return;
      if (router.latestLocation.pathname !== SETTINGS_ROUTE_PATH) return;
      if (router.history.canGoBack()) router.history.back();
      else void router.navigate({ to: "/", replace: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, pageTier, router]);

  return null;
}
