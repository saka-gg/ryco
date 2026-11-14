import { describe, expect, it, vi } from "vite-plus/test";

import {
  androidThreadHeaderMenuActions,
  iosThreadHeaderRightItems,
} from "./threadHeaderNativeMenu";
import type { ThreadHeaderMenuSection } from "./threadHeaderMenuModel";

const MENU: ReadonlyArray<ThreadHeaderMenuSection> = [
  {
    id: "workspace",
    collapsed: { title: "Workspace", icon: "folder" },
    actions: [{ id: "files", title: "Files", icon: "doc", subtitle: "3 changed" }],
  },
  {
    id: "state",
    actions: [{ id: "archive", title: "Archive", icon: "archivebox", disabled: true }],
    more: [{ id: "delete", title: "Delete", icon: "trash", destructive: true }],
  },
];

describe("iosThreadHeaderRightItems", () => {
  it("builds one ⋯ menu with a submenu per group, inline unless collapsed", () => {
    const run = vi.fn();
    const [item] = iosThreadHeaderRightItems(MENU, run);
    expect(item).toMatchObject({ type: "menu", accessibilityLabel: "More chat actions" });
    const groups = item?.type === "menu" ? item.menu.items : [];
    expect(groups).toMatchObject([
      {
        type: "submenu",
        label: "Workspace",
        icon: { type: "sfSymbol", name: "folder" },
        items: [{ type: "action", label: "Files", description: "3 changed", disabled: false }],
      },
      {
        type: "submenu",
        label: "",
        inline: true,
        items: [
          { type: "action", label: "Archive", disabled: true, destructive: false },
          {
            type: "submenu",
            label: "More",
            items: [{ type: "action", label: "Delete", destructive: true }],
          },
        ],
      },
    ]);
  });

  it("runs the action's id when its item is pressed", () => {
    const run = vi.fn();
    const [item] = iosThreadHeaderRightItems(MENU, run);
    const groups = item?.type === "menu" ? item.menu.items : [];
    const files = groups[0]?.type === "submenu" ? groups[0].items[0] : undefined;
    if (files?.type === "action") files.onPress();
    expect(run).toHaveBeenCalledWith("files");
  });
});

describe("androidThreadHeaderMenuActions", () => {
  it("flattens every group, More rows included, into native menu actions", () => {
    expect(androidThreadHeaderMenuActions(MENU)).toEqual([
      {
        id: "files",
        title: "Files",
        subtitle: "3 changed",
        attributes: { disabled: false, destructive: false },
      },
      { id: "archive", title: "Archive", attributes: { disabled: true, destructive: false } },
      { id: "delete", title: "Delete", attributes: { disabled: false, destructive: true } },
    ]);
  });
});
