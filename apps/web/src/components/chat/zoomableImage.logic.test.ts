import { describe, expect, it } from "vite-plus/test";

import { clampImageOffset, stepImageZoom, zoomImageAt } from "./zoomableImage.logic";

const BOX = { width: 400, height: 200 };

describe("zoomable image", () => {
  it("steps between fit and 8x", () => {
    expect(stepImageZoom(1, 1)).toBe(1.25);
    expect(stepImageZoom(1, -1)).toBe(1);
    expect(stepImageZoom(1.7, -1)).toBe(1.5);
    expect(stepImageZoom(8, 1)).toBe(8);
  });

  it("keeps the point under the pointer still while zooming", () => {
    const zoomed = zoomImageAt({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: 50 }, BOX);
    // The image point at +100,+50 stays at +100,+50: offset = p - p*2.
    expect(zoomed).toEqual({ scale: 2, x: -100, y: -50 });
    expect(zoomImageAt(zoomed, 1, { x: 0, y: 0 }, BOX)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("never pans an edge inside the box", () => {
    expect(clampImageOffset({ scale: 2, x: 999, y: -999 }, BOX)).toEqual({
      scale: 2,
      x: 200,
      y: -100,
    });
    expect(clampImageOffset({ scale: 1, x: 30, y: 30 }, BOX)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
