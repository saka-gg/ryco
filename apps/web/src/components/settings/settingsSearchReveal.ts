import { create } from "zustand";

/** A settings row to scroll to and focus once its section shows. */
export interface SettingsSearchTarget {
  readonly targetId: string;
}

/**
 * Where Connections starts a pairing link: the Network access row. It decides
 * whether another device can reach this backend, and Authorized clients, where
 * links are created, follows once one can. No heading reads "Pairing link", so
 * the search result and first-run setup reveal the row by this id.
 */
export const PAIRING_LINK_TARGET_ID = "pairing-link";

/**
 * A row the command palette, first-run setup or a link such as the Usage
 * page's "Set prices" asked the settings page to reveal. They ask before the
 * page has mounted, so the request waits here until the page takes it. Only
 * lazy surfaces import this module: Settings, the palette, the setup dialog
 * and those links.
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
