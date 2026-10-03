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

/** Warm the settings page chunk before the first open, so it never flashes empty. */
export function preloadSettingsPage(): void {
  void import("./components/settings/SettingsPage");
}
