import { describe, expect, it } from "vite-plus/test";

import { createTabStripWheelMapping, TAB_STRIP_WHEEL_GESTURE_GAP_MS } from "./tabStrip";

const wheel = (timeStamp: number, deltaY: number, deltaX = 0, ctrlKey = false) => ({
  timeStamp,
  deltaX,
  deltaY,
  ctrlKey,
});

describe("createTabStripWheelMapping", () => {
  it("turns a mouse wheel's vertical scroll into sideways scrolling", () => {
    const map = createTabStripWheelMapping();

    expect(map(wheel(0, 40))).toBe(40);
    expect(map(wheel(16, -40))).toBe(-40);
  });

  it("leaves a sideways gesture to the browser, including its vertical-only samples", () => {
    const map = createTabStripWheelMapping();

    expect(map(wheel(0, 2, 30))).toBe(0);
    // A trackpad briefly reports no sideways movement mid-gesture.
    expect(map(wheel(16, 3, 0))).toBe(0);
    // After a pause, a plain wheel scroll maps again.
    expect(map(wheel(16 + TAB_STRIP_WHEEL_GESTURE_GAP_MS + 1, 40))).toBe(40);
  });

  it("never maps pinch zoom or a sample without vertical movement", () => {
    const map = createTabStripWheelMapping();

    expect(map(wheel(0, 40, 0, true))).toBe(0);
    expect(map(wheel(16, 0))).toBe(0);
  });
});
