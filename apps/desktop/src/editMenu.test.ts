import type { BaseWindow, MenuItem, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildEditMenu } from "./editMenu.ts";

function items(mac: boolean, onPasteAsText = vi.fn()) {
  const submenu = buildEditMenu({ mac, onPasteAsText }).submenu;
  if (!Array.isArray(submenu)) throw new Error("Expected the Edit menu to list its items.");
  return submenu as MenuItemConstructorOptions[];
}

type ClickEvent = Parameters<NonNullable<MenuItemConstructorOptions["click"]>>[2];

const roles = (menu: MenuItemConstructorOptions[]) =>
  menu.flatMap((item) => (item.role ? [item.role] : []));

describe("buildEditMenu", () => {
  it("offers Paste as Text in place of Paste and Match Style", () => {
    for (const mac of [true, false]) {
      const menu = items(mac);
      expect(roles(menu)).not.toContain("pasteAndMatchStyle");
      expect(roles(menu)).toEqual(
        expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"]),
      );
      const pasteAsText = menu.find(
        (item) => item.label === "Paste as Text" && item.visible !== false,
      );
      expect(pasteAsText?.accelerator).toBe("CmdOrCtrl+Shift+V");
    }
  });

  it("keeps Paste and Match Style's chord on macOS as a hidden alias", () => {
    const aliases = (mac: boolean) =>
      items(mac).filter((item) => item.label === "Paste as Text" && item.visible === false);
    expect(aliases(true).map((item) => item.accelerator)).toEqual(["Cmd+Alt+Shift+V"]);
    expect(aliases(false)).toEqual([]);
    expect(items(true).some((item) => item.label === "Speech")).toBe(true);
  });

  it("hands every Paste as Text click, by mouse or chord, to the window it was made in", () => {
    const onPasteAsText = vi.fn();
    const window = { id: 1 } as unknown as BaseWindow;
    for (const item of items(true, onPasteAsText).filter(
      (entry) => entry.label === "Paste as Text",
    )) {
      item.click?.({} as MenuItem, window, {} as ClickEvent);
    }
    expect(onPasteAsText).toHaveBeenCalledTimes(2);
    expect(onPasteAsText).toHaveBeenNthCalledWith(1, window);
  });
});
