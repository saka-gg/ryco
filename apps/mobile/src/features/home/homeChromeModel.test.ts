import { describe, expect, it } from "vite-plus/test";

import { buildHomeChromeModel, HOME_LIST_PADDING_BOTTOM, HOME_MODE_TITLE } from "./homeChromeModel";
import type { HomeMode } from "./homeMode";

const MODES: ReadonlyArray<HomeMode> = ["inbox", "projects"];

describe("home chrome", () => {
  it("titles each mode", () => {
    expect(MODES.map((mode) => buildHomeChromeModel({ mode }).title)).toEqual([
      "Inbox",
      "Projects",
    ]);
  });

  it("always points the mark at Inbox, from every mode", () => {
    for (const mode of MODES) {
      const model = buildHomeChromeModel({ mode });
      expect(model.headerLeftTargetMode).toBe("inbox");
      expect(model.headerLeft.accessibilityLabel).toBe("Open Inbox");
    }
  });

  it("keeps only Settings in the header and names bottom search for each mode", () => {
    for (const mode of MODES) {
      const model = buildHomeChromeModel({ mode });
      expect(model.headerRight).toEqual([{ id: "settings", accessibilityLabel: "Settings" }]);
      expect(model.search).toEqual({
        id: "search",
        accessibilityLabel: `Search ${HOME_MODE_TITLE[mode]}`,
      });
    }
  });

  it("offers new task from every mode, matching the reach of the header + it replaces", () => {
    for (const mode of MODES) {
      expect(buildHomeChromeModel({ mode }).newTask).toEqual({
        id: "new-task",
        accessibilityLabel: "New Task",
      });
    }
  });

  it("never puts new task in the header", () => {
    for (const mode of MODES) {
      const ids = buildHomeChromeModel({ mode }).headerRight.map((button) => button.id);
      expect(ids).not.toContain("new-task");
    }
  });

  it("clears the bottom toolbar with the list padding", () => {
    // 34 home indicator + 16 gap + 56 button + 18 breathing room.
    expect(HOME_LIST_PADDING_BOTTOM).toBe(124);
    expect(HOME_LIST_PADDING_BOTTOM).toBeGreaterThan(34 + 16 + 56);
  });

  it("keeps the mode-title table aligned with the model", () => {
    for (const mode of MODES) {
      expect(buildHomeChromeModel({ mode }).title).toBe(HOME_MODE_TITLE[mode]);
    }
  });
});
