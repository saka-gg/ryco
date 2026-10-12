import { lazyRouteComponent } from "@tanstack/react-router";

import { useSettingsDialogStore } from "./settingsDialogStore";

/**
 * Where desktop and tablet settings live.
 *
 * Settings used to be a modal dialog; it is now a page that replaces the main
 * content, like Statistics. The settings store still owns which destination and
 * section are shown — the frozen phone tier presents the same store as a sheet
 * — and its `open` flag mirrors "the settings page is the current route" on
 * every other tier. `SettingsRouteBridge` keeps the two in step.
 */
export const SETTINGS_ROUTE_PATH = "/settings";

/**
 * The `/settings` route component. It lives here rather than in the route file
 * so `preloadSettingsPage` warms the exact component the router awaits: once
 * loaded, the page renders on the first pass instead of suspending.
 */
export const SettingsRouteComponent = lazyRouteComponent(
  () => import("./components/routeViews/SettingsRouteView"),
  "SettingsRoute",
);

/** Warm the settings page chunk before the first open, so it never flashes empty. */
export function preloadSettingsPage(): void {
  void SettingsRouteComponent.preload?.();
}

/**
 * Warms the body of the section the page is about to show, so a settings open
 * commits with that section instead of its skeleton. The `/settings` route
 * loader runs it alongside the page chunk. Never rejects.
 */
export function preloadOpenSettingsSection(): Promise<void> {
  const section = useSettingsDialogStore.getState().section;
  return import("./components/settings/SettingsPage")
    .then((module) => module.preloadSettingsSection(section))
    .catch(() => undefined);
}
