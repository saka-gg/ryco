import { describe, expect, it } from "vitest";

import {
  CELL_SIZE,
  MAX_CANVAS_PIXELS,
  VORTEX_LIFE_MS,
  canvasPixelRatio,
  cellExtent,
  computeBackgroundFrame,
  createBackgroundGrid,
  hasLiveVortex,
  valueNoise,
  vortexEnvelope,
  type FrameInput,
} from "./EmptyChatBackground.logic";

const BASE_INPUT: FrameInput = {
  elapsedMs: 5_000,
  seconds: 42,
  firstPreset: 0,
  fade: 1,
  vortices: [],
  nowMs: 10_000,
};

describe("valueNoise", () => {
  it("stays in [0, 1) and changes smoothly", () => {
    for (let index = 0; index < 200; index += 1) {
      const x = index * 0.37;
      const value = valueNoise(x, x * 0.5, index * 0.11);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(Math.abs(valueNoise(x + 0.001, x * 0.5, index * 0.11) - value)).toBeLessThan(0.01);
    }
  });
});

describe("vortexEnvelope", () => {
  it("is zero before and after its life and peaks halfway", () => {
    expect(vortexEnvelope(0)).toBe(0);
    expect(vortexEnvelope(VORTEX_LIFE_MS)).toBe(0);
    expect(vortexEnvelope(VORTEX_LIFE_MS / 2)).toBeCloseTo(1, 5);
    expect(vortexEnvelope(VORTEX_LIFE_MS / 4)).toBeLessThan(vortexEnvelope(VORTEX_LIFE_MS / 2));
  });

  it("reports live vortices only within their life", () => {
    const vortices = [{ x: 0, y: 0, startMs: 1_000 }];
    expect(hasLiveVortex(vortices, 1_000 + VORTEX_LIFE_MS - 1)).toBe(true);
    expect(hasLiveVortex(vortices, 1_000 + VORTEX_LIFE_MS)).toBe(false);
  });
});

describe("computeBackgroundFrame", () => {
  for (const variant of ["flow", "halftone"] as const) {
    it(`draws ${variant} cells in the foreground color only without a vortex`, () => {
      const grid = createBackgroundGrid(variant, 800, 500);
      const count = computeBackgroundFrame(grid, BASE_INPUT);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(grid.cols * grid.rows);
      for (let index = 0; index < count; index += 1) {
        expect(grid.frame.accentAlpha[index]).toBe(0);
        expect(grid.frame.inkAlpha[index]).toBeGreaterThan(0);
        expect(grid.frame.inkAlpha[index]).toBeLessThanOrEqual(1);
      }
    });

    it(`draws nothing for ${variant} before the fade-in starts`, () => {
      const grid = createBackgroundGrid(variant, 800, 500);
      expect(computeBackgroundFrame(grid, { ...BASE_INPUT, fade: 0 })).toBe(0);
    });

    it(`twists ${variant} cells around a vortex in the accent color`, () => {
      const grid = createBackgroundGrid(variant, 800, 500);
      const vortex = { x: 400, y: 250, startMs: BASE_INPUT.nowMs - VORTEX_LIFE_MS / 2 };
      const count = computeBackgroundFrame(grid, { ...BASE_INPUT, vortices: [vortex] });
      const cell = CELL_SIZE[variant];
      let tinted = 0;
      let moved = 0;
      for (let index = 0; index < count; index += 1) {
        const x = grid.frame.x[index]!;
        const y = grid.frame.y[index]!;
        if (grid.frame.accentAlpha[index]! > 0) {
          tinted += 1;
          // Only near the click.
          expect(Math.hypot(x - vortex.x, y - vortex.y)).toBeLessThan(400);
        }
        // Off the grid means the vortex carried the cell around the click.
        const offGrid = Math.abs(((x / cell - 0.5) % 1) + 1) % 1;
        if (offGrid > 0.05 && offGrid < 0.95) moved += 1;
      }
      expect(tinted).toBeGreaterThan(20);
      expect(moved).toBeGreaterThan(20);
    });
  }

  it("ignores vortices that already ended", () => {
    const grid = createBackgroundGrid("flow", 800, 500);
    const ended = { x: 400, y: 250, startMs: BASE_INPUT.nowMs - VORTEX_LIFE_MS - 1 };
    const count = computeBackgroundFrame(grid, { ...BASE_INPUT, vortices: [ended] });
    for (let index = 0; index < count; index += 1) {
      expect(grid.frame.accentAlpha[index]).toBe(0);
    }
  });
});

describe("canvasPixelRatio", () => {
  it("caps at 2 and at the canvas pixel budget", () => {
    expect(canvasPixelRatio(3, 800, 600)).toBe(2);
    expect(canvasPixelRatio(1, 800, 600)).toBe(1);
    const large = canvasPixelRatio(2, 4000, 2500);
    expect(4000 * 2500 * large * large).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
  });
});

describe("cellExtent", () => {
  it("keeps strokes and dots inside their reach", () => {
    expect(cellExtent("flow", 1, 10)).toBeLessThanOrEqual(CELL_SIZE.flow * 0.9);
    expect(cellExtent("halftone", 1, 10)).toBeLessThanOrEqual(CELL_SIZE.halftone * 0.8);
    expect(cellExtent("halftone", 0, 1)).toBe(0);
  });
});
