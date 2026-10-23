import { describe, expect, it, vi } from "vite-plus/test";

import { BUILT_IN_THEMES } from "../themes/builtin";
import type { ThemeDefinition } from "../themes/types";
import { filterCommandPaletteGroups } from "./CommandPalette.logic";
import {
  buildAppearancePaletteItems,
  type AppearancePaletteInput,
} from "./CommandPaletteAppearance";

const CUSTOM_THEME: ThemeDefinition = { id: "custom-sunset", name: "Sunset", builtIn: false };

function makeInput(overrides: Partial<AppearancePaletteInput> = {}): AppearancePaletteInput {
  return {
    themes: [...BUILT_IN_THEMES, CUSTOM_THEME],
    activeThemeId: "nord",
    theme: "dark",
    resolvedTheme: "dark",
    setActiveTheme: vi.fn(),
    setTheme: vi.fn(),
    ...overrides,
  };
}

function pageItems(item: ReturnType<typeof buildAppearancePaletteItems>[number]) {
  return item.groups.flatMap((group) => group.items);
}

describe("buildAppearancePaletteItems", () => {
  it("lists every built-in and custom theme and marks the active one", () => {
    const [changeTheme] = buildAppearancePaletteItems(makeInput());
    const items = pageItems(changeTheme);

    expect(items.map((item) => item.title)).toEqual([
      ...BUILT_IN_THEMES.map((theme) => theme.name),
      "Sunset",
    ]);
    expect(items.filter((item) => item.titleTrailingContent).map((item) => item.value)).toEqual([
      "theme:nord",
    ]);
  });

  it("marks the current color mode", () => {
    const [, changeColorMode] = buildAppearancePaletteItems(makeInput({ theme: "system" }));
    const items = pageItems(changeColorMode);

    expect(items.map((item) => item.title)).toEqual(["System", "Light", "Dark"]);
    expect(items.filter((item) => item.titleTrailingContent).map((item) => item.value)).toEqual([
      "color-mode:system",
    ]);
  });

  it("applies a theme or color mode through the theme setters", async () => {
    const input = makeInput();
    const [changeTheme, changeColorMode] = buildAppearancePaletteItems(input);

    for (const item of [...pageItems(changeTheme), ...pageItems(changeColorMode)]) {
      if (item.kind !== "action") throw new Error("expected action item");
      if (item.value === "theme:custom-sunset" || item.value === "color-mode:light") {
        await item.run();
      }
    }

    expect(input.setActiveTheme).toHaveBeenCalledExactlyOnceWith("custom-sunset");
    expect(input.setTheme).toHaveBeenCalledExactlyOnceWith("light");
  });

  it("finds the theme page by a theme name from the root", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        { value: "actions", label: "Actions", items: buildAppearancePaletteItems(makeInput()) },
      ],
      query: "sunset",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "action:change-theme",
    ]);
  });
});
