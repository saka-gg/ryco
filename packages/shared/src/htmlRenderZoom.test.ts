import { describe, expect, it } from "vite-plus/test";

import {
  clampHtmlRenderZoom,
  fitHtmlRenderZoom,
  formatHtmlRenderZoom,
  htmlRenderZoomFrameStyle,
  scaleHtmlRenderZoom,
  stepHtmlRenderZoom,
  wheelHtmlRenderZoom,
} from "./htmlRenderZoom.ts";

describe("html render zoom", () => {
  it("steps through the browser's levels and stops at the ends", () => {
    expect(stepHtmlRenderZoom(1, 1)).toBe(1.1);
    expect(stepHtmlRenderZoom(1, -1)).toBe(0.9);
    expect(stepHtmlRenderZoom(1.2, 1)).toBe(1.25);
    expect(stepHtmlRenderZoom(1.2, -1)).toBe(1.1);
    // A pinch a hair off a step counts as the step.
    expect(stepHtmlRenderZoom(1.249, 1)).toBe(1.5);
    expect(stepHtmlRenderZoom(4, 1)).toBe(4);
    expect(stepHtmlRenderZoom(0.25, -1)).toBe(0.25);
  });

  it("clamps any zoom, and reads a broken one as 100%", () => {
    expect(clampHtmlRenderZoom(10)).toBe(4);
    expect(clampHtmlRenderZoom(0.01)).toBe(0.25);
    expect(clampHtmlRenderZoom(Number.NaN)).toBe(1);
  });

  it("zooms proportionally on a pinch and about a step per wheel notch", () => {
    expect(wheelHtmlRenderZoom(1, -10)).toBeCloseTo(Math.exp(10 / 250));
    expect(wheelHtmlRenderZoom(1, 100)).toBe(0.8);
    expect(wheelHtmlRenderZoom(1, -100)).toBe(1.25);
    expect(wheelHtmlRenderZoom(4, -100)).toBe(4);
    expect(scaleHtmlRenderZoom(1, 1.1)).toBeCloseTo(1.1);
    expect(scaleHtmlRenderZoom(1, 0)).toBe(1);
  });

  it("fits a page wider than its frame and leaves a fitting page at 100%", () => {
    // A 1400 px page in a 700 px box.
    expect(
      fitHtmlRenderZoom({ boxWidth: 700, zoom: 1, content: { width: 1400, viewportWidth: 700 } }),
    ).toBe(0.5);
    // Already fitted: the frame is as wide as the page.
    expect(
      fitHtmlRenderZoom({
        boxWidth: 700,
        zoom: 0.5,
        content: { width: 1400, viewportWidth: 1400 },
      }),
    ).toBe(null);
    // A responsive page at 100% or more fits at 100%.
    expect(
      fitHtmlRenderZoom({ boxWidth: 700, zoom: 1.5, content: { width: 467, viewportWidth: 467 } }),
    ).toBe(1);
    // Never zooms in to fit.
    expect(
      fitHtmlRenderZoom({ boxWidth: 700, zoom: 1, content: { width: 800, viewportWidth: 300 } }),
    ).toBe(0.875);
    expect(fitHtmlRenderZoom({ boxWidth: 700, zoom: 1, content: undefined })).toBe(null);
  });

  it("lays the frame out narrower and scales it up", () => {
    expect(htmlRenderZoomFrameStyle(1)).toEqual({
      width: "100%",
      height: "100%",
      transform: undefined,
      transformOrigin: "0 0",
    });
    expect(htmlRenderZoomFrameStyle(2)).toMatchObject({
      width: "50.0000%",
      height: "50.0000%",
      transform: "scale(2)",
    });
    expect(formatHtmlRenderZoom(0.6667)).toBe("67%");
  });
});
