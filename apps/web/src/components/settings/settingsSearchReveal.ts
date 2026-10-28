import { create } from "zustand";

/** A settings row to scroll to and focus once its section shows. */
export interface SettingsSearchTarget {
  readonly targetId: string;
}

/**
 * A row the command palette asked the settings page to reveal. The palette
 * asks before the page has mounted, so the request waits here until the page
 * takes it. Only the page and the palette import this module.
 */
export const useSettingsSearchRevealStore = create<{
  readonly request: SettingsSearchTarget | null;
}>(() => ({ request: null }));

export function requestSettingsReveal(targetId: string): void {
  useSettingsSearchRevealStore.setState({ request: { targetId } });
}

/** The page took `request`: drop it, unless a newer request replaced it. */
export function takeSettingsReveal(request: SettingsSearchTarget): void {
  if (useSettingsSearchRevealStore.getState().request !== request) return;
  useSettingsSearchRevealStore.setState({ request: null });
}
