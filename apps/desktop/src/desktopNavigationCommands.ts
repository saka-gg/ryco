import {
  DESKTOP_NAVIGATE_BACK_MENU_ACTION,
  DESKTOP_NAVIGATE_FORWARD_MENU_ACTION,
} from "@ryco/contracts";
import type { NavigationHistory } from "electron";

export type WindowNavigation = "back" | "forward";

/**
 * A macOS trackpad swipe between pages. Electron names it from the swipe's deltaX ("left" for 1,
 * "right" for -1); like Firefox and VS Code, "left" goes back. Up and down are null.
 *
 * A mouse's back and forward buttons are not window events here: Chromium hands them to the page
 * under the pointer, which steps its own history (the app reads them itself). Electron also
 * reports them as `app-command` on Windows and Linux, so moving on that event as well would go
 * two pages at once; the window leaves app commands alone.
 */
export function swipeNavigation(direction: string): WindowNavigation | null {
  if (direction === "left") return "back";
  if (direction === "right") return "forward";
  return null;
}

/**
 * Goes back or forward as a browser would, in the window's page that has focus: a page shown in
 * the window, such as the browser panel's, moves itself; otherwise the app gets the menu action
 * and steps its own history. A focused page with nowhere to go stays put; the app does not move
 * in its place.
 */
export function navigateWindow(input: {
  readonly navigation: WindowNavigation | null;
  readonly focusedPage: {
    readonly navigationHistory: Pick<
      NavigationHistory,
      "canGoBack" | "canGoForward" | "goBack" | "goForward"
    >;
  } | null;
  readonly sendToApp: (action: string) => void;
}): void {
  if (!input.navigation) return;
  const history = input.focusedPage?.navigationHistory;
  if (!history) {
    input.sendToApp(
      input.navigation === "back"
        ? DESKTOP_NAVIGATE_BACK_MENU_ACTION
        : DESKTOP_NAVIGATE_FORWARD_MENU_ACTION,
    );
  } else if (input.navigation === "back") {
    if (history.canGoBack()) history.goBack();
  } else if (history.canGoForward()) {
    history.goForward();
  }
}
