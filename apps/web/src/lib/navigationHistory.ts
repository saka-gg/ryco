import {
  DESKTOP_NAVIGATE_BACK_MENU_ACTION,
  DESKTOP_NAVIGATE_FORWARD_MENU_ACTION,
  type DesktopBridge,
} from "@ryco/contracts";
import type { RouterHistory } from "@tanstack/react-router";

import { hasOpenDialogShortcutTarget } from "../keybindings";
import { getPresentationTier } from "./presentationTier";
import { isMacPlatform } from "./utils";

export type NavigationHistoryDirection = "back" | "forward";

/**
 * Moves one page back or forward through the router history. Back stops at
 * the first page the app opened, so it never leaves Ryco. Forward goes where
 * the browser's own Forward would, and does nothing without a later page.
 */
export function stepNavigationHistory(
  history: RouterHistory,
  direction: NavigationHistoryDirection,
): void {
  // Router pushes reach the browser a microtask later; flushing first makes
  // the step start from the page on screen.
  history.flush();
  if (direction === "forward") {
    history.forward();
  } else if (history.canGoBack()) {
    history.back();
  }
}

/**
 * Steps the history for the desktop app's mouse back and forward buttons,
 * browser keys and trackpad swipes. Windows and Linux report the mouse buttons
 * to the desktop app, which sends them as menu actions with the rest; macOS
 * reports them only to the page, so they are read here. Open dialogs and the
 * phone tier keep them, as they keep the keys.
 */
export function installDesktopHistoryNavigation(
  history: RouterHistory,
  bridge: Pick<DesktopBridge, "onMenuAction"> | undefined,
  target: Window,
): () => void {
  if (!bridge) return () => {};
  const step = (direction: NavigationHistoryDirection) => {
    if (hasOpenDialogShortcutTarget() || getPresentationTier() === "phone") return;
    stepNavigationHistory(history, direction);
  };
  const unsubscribe = bridge.onMenuAction((action) => {
    if (action === DESKTOP_NAVIGATE_BACK_MENU_ACTION) step("back");
    else if (action === DESKTOP_NAVIGATE_FORWARD_MENU_ACTION) step("forward");
  });
  if (!isMacPlatform(target.navigator.platform)) return unsubscribe;
  const onMouseUp = (event: MouseEvent) => {
    // Buttons 3 and 4 are a mouse's back and forward buttons.
    if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return;
    event.preventDefault();
    step(event.button === 3 ? "back" : "forward");
  };
  target.addEventListener("mouseup", onMouseUp);
  return () => {
    unsubscribe();
    target.removeEventListener("mouseup", onMouseUp);
  };
}
