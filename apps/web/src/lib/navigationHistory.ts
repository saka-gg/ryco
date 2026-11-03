import {
  DESKTOP_NAVIGATE_BACK_MENU_ACTION,
  DESKTOP_NAVIGATE_FORWARD_MENU_ACTION,
  type DesktopBridge,
} from "@ryco/contracts";
import type { RouterHistory } from "@tanstack/react-router";

import { hasOpenDialogShortcutTarget } from "../keybindings";
import { getPresentationTier } from "./presentationTier";

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
 * Steps the history for the desktop app's trackpad swipes, which it sends as
 * menu actions, and for a mouse's back and forward buttons. Chromium itself
 * steps the page for a back or forward button the page leaves unconsumed, on
 * every platform, so the buttons are read and consumed here: that keeps them
 * to one step, and lets an open dialog keep them, as it keeps the keys. The
 * phone tier keeps Chromium's own handling.
 */
export function installDesktopHistoryNavigation(
  history: RouterHistory,
  bridge: Pick<DesktopBridge, "onMenuAction"> | undefined,
  target: Window,
): () => void {
  if (!bridge) return () => {};
  const unsubscribe = bridge.onMenuAction((action) => {
    const direction =
      action === DESKTOP_NAVIGATE_BACK_MENU_ACTION
        ? "back"
        : action === DESKTOP_NAVIGATE_FORWARD_MENU_ACTION
          ? "forward"
          : null;
    if (!direction || hasOpenDialogShortcutTarget() || getPresentationTier() === "phone") return;
    stepNavigationHistory(history, direction);
  });
  const onMouseUp = (event: MouseEvent) => {
    // Buttons 3 and 4 are a mouse's back and forward buttons.
    if (event.defaultPrevented || (event.button !== 3 && event.button !== 4)) return;
    if (getPresentationTier() === "phone") return;
    event.preventDefault();
    if (hasOpenDialogShortcutTarget()) return;
    stepNavigationHistory(history, event.button === 3 ? "back" : "forward");
  };
  target.addEventListener("mouseup", onMouseUp);
  return () => {
    unsubscribe();
    target.removeEventListener("mouseup", onMouseUp);
  };
}
