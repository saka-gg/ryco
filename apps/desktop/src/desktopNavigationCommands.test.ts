import {
  DESKTOP_NAVIGATE_BACK_MENU_ACTION,
  DESKTOP_NAVIGATE_FORWARD_MENU_ACTION,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  navigateWindow,
  swipeNavigation,
  type WindowNavigation,
} from "./desktopNavigationCommands.ts";

function page(input: { canGoBack: boolean; canGoForward: boolean }) {
  return {
    navigationHistory: {
      canGoBack: () => input.canGoBack,
      canGoForward: () => input.canGoForward,
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
  };
}

function navigate(
  navigation: WindowNavigation | null,
  focusedPage: ReturnType<typeof page> | null,
) {
  const sendToApp = vi.fn();
  navigateWindow({ navigation, focusedPage, sendToApp });
  return sendToApp;
}

describe("swipeNavigation", () => {
  it("goes back on a left swipe and forward on a right one", () => {
    expect(swipeNavigation("left")).toBe("back");
    expect(swipeNavigation("right")).toBe("forward");
    for (const direction of ["up", "down", ""]) {
      expect(swipeNavigation(direction)).toBeNull();
    }
  });
});

describe("navigateWindow", () => {
  it("tells the app when no page in the window has focus", () => {
    expect(navigate("back", null).mock.calls).toEqual([[DESKTOP_NAVIGATE_BACK_MENU_ACTION]]);
    expect(navigate("forward", null).mock.calls).toEqual([[DESKTOP_NAVIGATE_FORWARD_MENU_ACTION]]);
  });

  it("moves the focused browser panel page instead of the app", () => {
    const panel = page({ canGoBack: true, canGoForward: true });

    expect(navigate("back", panel)).not.toHaveBeenCalled();
    expect(navigate("forward", panel)).not.toHaveBeenCalled();
    expect(panel.navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(panel.navigationHistory.goForward).toHaveBeenCalledOnce();
  });

  it("leaves both still when the focused page has nowhere to go", () => {
    const panel = page({ canGoBack: false, canGoForward: false });

    expect(navigate("back", panel)).not.toHaveBeenCalled();
    expect(navigate("forward", panel)).not.toHaveBeenCalled();
    expect(panel.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(panel.navigationHistory.goForward).not.toHaveBeenCalled();
  });

  it("ignores input that is no navigation", () => {
    const panel = page({ canGoBack: true, canGoForward: true });

    expect(navigate(null, null)).not.toHaveBeenCalled();
    expect(navigate(null, panel)).not.toHaveBeenCalled();
    expect(panel.navigationHistory.goBack).not.toHaveBeenCalled();
  });
});
