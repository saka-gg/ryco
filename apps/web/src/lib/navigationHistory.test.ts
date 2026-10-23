import {
  DESKTOP_NAVIGATE_BACK_MENU_ACTION,
  DESKTOP_NAVIGATE_FORWARD_MENU_ACTION,
} from "@ryco/contracts";
import { createMemoryHistory } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installDesktopHistoryNavigation, stepNavigationHistory } from "./navigationHistory";

const shell = vi.hoisted(() => ({
  dialogOpen: false,
  tier: "desktop" as "phone" | "desktop",
}));

vi.mock("../keybindings", () => ({ hasOpenDialogShortcutTarget: () => shell.dialogOpen }));
vi.mock("./presentationTier", () => ({ getPresentationTier: () => shell.tier }));

function historyAt(...pathnames: string[]) {
  const history = createMemoryHistory({ initialEntries: [pathnames[0] ?? "/"] });
  for (const pathname of pathnames.slice(1)) history.push(pathname);
  return history;
}

describe("stepNavigationHistory", () => {
  it("stays on the first page instead of leaving the app", () => {
    const history = historyAt("/thread");
    const back = vi.spyOn(history, "back");

    stepNavigationHistory(history, "back");

    expect(back).not.toHaveBeenCalled();
    expect(history.location.pathname).toBe("/thread");
  });

  it("goes back and forward through visited pages", () => {
    const history = historyAt("/thread", "/pull-requests", "/settings");

    stepNavigationHistory(history, "back");
    expect(history.location.pathname).toBe("/pull-requests");
    stepNavigationHistory(history, "back");
    expect(history.location.pathname).toBe("/thread");
    stepNavigationHistory(history, "forward");
    expect(history.location.pathname).toBe("/pull-requests");
  });

  it("does nothing going forward from the newest page", () => {
    const history = historyAt("/thread", "/settings");

    stepNavigationHistory(history, "forward");

    expect(history.location.pathname).toBe("/settings");
  });

  it("drops the forward pages once a new page opens", () => {
    const history = historyAt("/thread", "/pull-requests");
    stepNavigationHistory(history, "back");
    history.push("/settings");

    stepNavigationHistory(history, "forward");

    expect(history.location.pathname).toBe("/settings");
    stepNavigationHistory(history, "back");
    expect(history.location.pathname).toBe("/thread");
  });

  it("flushes queued router writes before stepping", () => {
    const history = historyAt("/thread", "/settings");
    const flush = vi.spyOn(history, "flush");
    const back = vi.spyOn(history, "back");

    stepNavigationHistory(history, "back");

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(back.mock.invocationCallOrder[0]!);
  });
});

describe("installDesktopHistoryNavigation", () => {
  beforeEach(() => {
    shell.dialogOpen = false;
    shell.tier = "desktop";
  });

  function desktop(platform: string) {
    const history = historyAt("/thread", "/pull-requests", "/settings");
    const target = new EventTarget() as EventTarget & { navigator: { platform: string } };
    target.navigator = { platform };
    let menuListener: ((action: string) => void) | null = null;
    const uninstall = installDesktopHistoryNavigation(
      history,
      {
        onMenuAction: (listener) => {
          menuListener = listener;
          return () => {
            menuListener = null;
          };
        },
      },
      target as unknown as Window,
    );
    const mouseUp = (button: number) => {
      const event = Object.assign(new Event("mouseup", { cancelable: true }), { button });
      target.dispatchEvent(event);
      return event;
    };
    return {
      history,
      uninstall,
      mouseUp,
      menu: (action: string) => menuListener?.(action),
      hasMenuListener: () => menuListener !== null,
    };
  }

  it("goes back and forward on the desktop app's menu actions", () => {
    const app = desktop("Win32");

    app.menu("open-settings");
    expect(app.history.location.pathname).toBe("/settings");
    app.menu(DESKTOP_NAVIGATE_BACK_MENU_ACTION);
    expect(app.history.location.pathname).toBe("/pull-requests");
    app.menu(DESKTOP_NAVIGATE_FORWARD_MENU_ACTION);
    expect(app.history.location.pathname).toBe("/settings");
  });

  it("leaves the page to an open dialog and to the phone tier", () => {
    const app = desktop("MacIntel");

    shell.dialogOpen = true;
    app.menu(DESKTOP_NAVIGATE_BACK_MENU_ACTION);
    app.mouseUp(3);
    expect(app.history.location.pathname).toBe("/settings");

    shell.dialogOpen = false;
    shell.tier = "phone";
    app.menu(DESKTOP_NAVIGATE_BACK_MENU_ACTION);
    app.mouseUp(3);
    expect(app.history.location.pathname).toBe("/settings");
  });

  it("reads the mouse back and forward buttons on macOS only", () => {
    const mac = desktop("MacIntel");

    expect(mac.mouseUp(0).defaultPrevented).toBe(false);
    expect(mac.history.location.pathname).toBe("/settings");
    expect(mac.mouseUp(3).defaultPrevented).toBe(true);
    expect(mac.history.location.pathname).toBe("/pull-requests");
    expect(mac.mouseUp(4).defaultPrevented).toBe(true);
    expect(mac.history.location.pathname).toBe("/settings");

    // Windows and Linux send the buttons as menu actions; reading them here
    // as well would go back twice.
    const windows = desktop("Win32");
    expect(windows.mouseUp(3).defaultPrevented).toBe(false);
    expect(windows.history.location.pathname).toBe("/settings");
  });

  it("installs nothing without the desktop bridge", () => {
    const history = historyAt("/thread", "/settings");
    const target = new EventTarget() as EventTarget & { navigator: { platform: string } };
    target.navigator = { platform: "MacIntel" };
    const addEventListener = vi.spyOn(target, "addEventListener");

    installDesktopHistoryNavigation(history, undefined, target as unknown as Window)();

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("stops listening once uninstalled", () => {
    const app = desktop("MacIntel");

    app.uninstall();

    expect(app.hasMenuListener()).toBe(false);
    app.mouseUp(3);
    expect(app.history.location.pathname).toBe("/settings");
  });
});
