import { describe, expect, it } from "vite-plus/test";

import {
  FLOATING_ACTION_CLEARANCE,
  HOME_LIST_PADDING_BOTTOM,
  listBottomPadding,
} from "./homeChromeModel";

describe("list bottom padding", () => {
  it("clears the tab bar and the floating New task button inside a tab", () => {
    // 56 button + 16 gap above the tab bar, and a little air.
    expect(FLOATING_ACTION_CLEARANCE).toBeGreaterThan(56 + 16);
    expect(listBottomPadding({ bottom: 83 })).toBe(83 + FLOATING_ACTION_CLEARANCE);
  });

  it("keeps the old room for the bottom chrome outside the tabs", () => {
    expect(listBottomPadding(undefined)).toBe(HOME_LIST_PADDING_BOTTOM);
  });
});
