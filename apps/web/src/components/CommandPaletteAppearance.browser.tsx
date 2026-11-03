import { afterEach, describe, expect, it } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import { __resetThemeControllerForTests } from "../hooks/useTheme";
import {
  ACTIVE_THEME_STORAGE_KEY,
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME,
  addCustomTheme,
  applyThemeToDocument,
} from "../themes/registry";
import { useAppearancePaletteItems } from "./CommandPaletteAppearance";

describe("useAppearancePaletteItems", () => {
  afterEach(() => {
    localStorage.removeItem("ryco:theme");
    localStorage.removeItem(ACTIVE_THEME_STORAGE_KEY);
    localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
    applyThemeToDocument(DEFAULT_THEME);
    document.documentElement.classList.remove("dark");
    __resetThemeControllerForTests();
  });

  it("follows the active theme and themes added while the palette is open", async () => {
    const hook = await renderHook(() => useAppearancePaletteItems());
    const themeItems = () => hook.result.current[0].groups.flatMap((group) => group.items);
    const currentThemeValue = () => themeItems().find((item) => item.titleTrailingContent)?.value;

    try {
      expect(currentThemeValue()).toBe(`theme:${DEFAULT_THEME.id}`);

      const nord = themeItems().find((item) => item.value === "theme:nord");
      if (nord?.kind !== "action") throw new Error("expected the Nord theme action");
      await nord.run();
      await expect.poll(currentThemeValue).toBe("theme:nord");
      expect(localStorage.getItem(ACTIVE_THEME_STORAGE_KEY)).toBe("nord");

      addCustomTheme({ id: "custom-sunset", name: "Sunset", builtIn: false });
      await expect.poll(() => themeItems().at(-1)?.value).toBe("theme:custom-sunset");
    } finally {
      await hook.unmount();
    }
  });
});
