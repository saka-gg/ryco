import { describe, expect, it } from "vite-plus/test";
import { chartCeiling, closestPoint, monotonePath } from "./chartGeometry";

describe("native statistics chart geometry", () => {
  it("handles empty, one-day, and flat series without invalid paths", () => {
    expect(monotonePath([])).toBe("");
    expect(monotonePath([{ x: 10, y: 20 }])).toBe("M10,20");
    expect(
      monotonePath([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
      ]),
    ).toBe("M0,0C1,0 2,0 3,0");
  });
  it("flattens the tangent at peaks instead of overshooting the recorded maximum", () => {
    expect(
      monotonePath([
        { x: 0, y: 0 },
        { x: 3, y: 6 },
        { x: 6, y: 0 },
      ]),
    ).toBe("M0,0C1,3 2,6 3,6C4,6 5,3 6,0");
  });
  it("keeps axis ceilings readable and above the data", () => {
    for (const maximum of [0, 0.01, 7, 31, 300, 570, 1e9]) {
      expect(chartCeiling(maximum)).toBeGreaterThanOrEqual(maximum);
      expect(Number.isFinite(chartCeiling(maximum))).toBe(true);
    }
    expect(chartCeiling(570)).toBe(600);
  });
  it("clamps scrub selection to the plotted dates", () => {
    expect(closestPoint(-100, 40, 200, 7)).toBe(0);
    expect(closestPoint(140, 40, 200, 7)).toBe(3);
    expect(closestPoint(999, 40, 200, 7)).toBe(6);
  });
});
