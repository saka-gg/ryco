import { describe, expect, it } from "vite-plus/test";

import {
  armedSwipeSide,
  fullSwipeThreshold,
  swipeActionEntryRange,
  swipeActionsWidth,
} from "./threadSwipeModel";

describe("thread swipe geometry", () => {
  it("sizes the revealed actions per button", () => {
    expect(swipeActionsWidth(1)).toBe(58);
    expect(swipeActionsWidth(2)).toBe(116);
  });

  it("arms a full swipe past the actions and most of the row", () => {
    // A phone row: 58 % of the width wins.
    expect(fullSwipeThreshold(2, 370)).toBeCloseTo(214.6);
    // A narrow row still needs 44 points past the actions.
    expect(fullSwipeThreshold(2, 200)).toBe(160);
    expect(fullSwipeThreshold(1, 120)).toBe(102);
  });

  it("leads with the outer button when two are revealed", () => {
    expect(swipeActionEntryRange("outer", 2)).toEqual([8, 58 * 0.72]);
    expect(swipeActionEntryRange("inner", 2)).toEqual([58 * 0.55, 116 * 0.85]);
    expect(swipeActionEntryRange("inner", 1)).toEqual([8, 58 * 0.72]);
  });

  it("names the armed side from the translation", () => {
    const thresholds = { leading: 100, trailing: 200 };
    expect(armedSwipeSide(-199, thresholds)).toBeNull();
    expect(armedSwipeSide(-200, thresholds)).toBe("trailing");
    expect(armedSwipeSide(100, thresholds)).toBe("leading");
    expect(armedSwipeSide(500, { leading: null, trailing: 200 })).toBeNull();
  });
});
