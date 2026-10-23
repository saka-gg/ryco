import { DESKTOP_PASTE_AS_TEXT_MENU_ACTION } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { installDesktopPasteAsText, PASTE_AS_TEXT_EVENT } from "./desktopPasteAsText";

function harness() {
  const target = new EventTarget() as EventTarget & {
    navigator: { platform: string };
    performance: { now: () => number };
  };
  let now = 1_000;
  target.navigator = { platform: "MacIntel" };
  target.performance = { now: () => now };
  let menuListener: ((action: string) => void) | null = null;
  const pasteAsText = vi.fn(() => Promise.resolve());
  const announced = vi.fn();
  target.addEventListener(PASTE_AS_TEXT_EVENT, announced);
  const uninstall = installDesktopPasteAsText(
    {
      onMenuAction: (listener) => {
        menuListener = listener;
        return () => {
          menuListener = null;
        };
      },
      pasteAsText,
    },
    target as unknown as Window,
  );
  const dispatch = (type: string, init: Record<string, unknown> = {}) => {
    const event = new Event(type);
    Object.defineProperty(event, "timeStamp", { value: now });
    target.dispatchEvent(Object.assign(event, init));
  };
  return {
    pasteAsText,
    announced,
    uninstall,
    menu: (action: string) => menuListener?.(action),
    hasMenuListener: () => menuListener !== null,
    chord: () =>
      dispatch("keydown", {
        key: "v",
        code: "KeyV",
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    paste: () => dispatch("paste"),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("installDesktopPasteAsText", () => {
  it("announces the menu's paste, then asks the desktop app for it", () => {
    const desktop = harness();
    desktop.menu("open-settings");
    expect(desktop.pasteAsText).not.toHaveBeenCalled();
    desktop.menu(DESKTOP_PASTE_AS_TEXT_MENU_ACTION);
    expect(desktop.announced).toHaveBeenCalledTimes(1);
    expect(desktop.pasteAsText).toHaveBeenCalledTimes(1);
    expect(desktop.announced.mock.invocationCallOrder[0]).toBeLessThan(
      desktop.pasteAsText.mock.invocationCallOrder[0]!,
    );
  });

  it("adds no paste when the shortcut's own keypress already pasted", () => {
    const desktop = harness();
    desktop.chord();
    desktop.paste();
    desktop.menu(DESKTOP_PASTE_AS_TEXT_MENU_ACTION);
    expect(desktop.pasteAsText).not.toHaveBeenCalled();
    expect(desktop.announced).not.toHaveBeenCalled();
  });

  it("pastes for a shortcut that did not paste by itself, or one pressed long before", () => {
    const desktop = harness();
    desktop.chord();
    desktop.menu(DESKTOP_PASTE_AS_TEXT_MENU_ACTION);
    expect(desktop.pasteAsText).toHaveBeenCalledTimes(1);

    desktop.chord();
    desktop.paste();
    desktop.advance(5_000);
    desktop.menu(DESKTOP_PASTE_AS_TEXT_MENU_ACTION);
    expect(desktop.pasteAsText).toHaveBeenCalledTimes(2);
  });

  it("does nothing outside a desktop app that can paste as text, and uninstalls", () => {
    const uninstall = installDesktopPasteAsText(undefined, new EventTarget() as unknown as Window);
    uninstall();
    const desktop = harness();
    desktop.uninstall();
    expect(desktop.hasMenuListener()).toBe(false);
  });
});
