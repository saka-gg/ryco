import { describe, expect, it } from "vite-plus/test";

import {
  MINI_PLAYER_EDGE_GAP,
  resizeMiniPlayer,
  resolveMiniPlayerFrame,
} from "./workspaceMiniPlayerLayout";

const container = { width: 1000, height: 800 };
const aspect = 0.5;

describe("workspace mini-player layout", () => {
  it("starts in the top-right corner at its default size", () => {
    const frame = resolveMiniPlayerFrame({ width: null, position: null, aspect, container });
    expect(frame.x + frame.width).toBe(container.width - MINI_PLAYER_EDGE_GAP);
    expect(frame.y).toBe(MINI_PLAYER_EDGE_GAP);
    // The content keeps the aspect ratio; the chrome does not scale.
    expect(frame.height - 28).toBeCloseTo(frame.width / aspect, 0);
  });

  it("keeps clear of the composer below it", () => {
    const frame = resolveMiniPlayerFrame({
      width: 300,
      position: { x: 400, y: 700 },
      aspect,
      container,
      obstacles: { composer: { left: 200, right: 800, height: 150 } },
    });
    expect(frame.y + frame.height).toBeLessThanOrEqual(800 - 150 - MINI_PLAYER_EDGE_GAP);
  });

  it("stays inside the column when the column shrinks, without forgetting its width", () => {
    const frame = resolveMiniPlayerFrame({
      width: 600,
      position: { x: 380, y: 10 },
      aspect: 2,
      container: { width: 400, height: 800 },
    });
    expect(frame.x).toBeGreaterThanOrEqual(MINI_PLAYER_EDGE_GAP);
    expect(frame.x + frame.width).toBeLessThanOrEqual(400 - MINI_PLAYER_EDGE_GAP);
  });

  it("resizes from the left edge and keeps the right edge in place", () => {
    const start = resolveMiniPlayerFrame({
      width: 200,
      position: { x: 500, y: 100 },
      aspect,
      container,
    });
    const next = resizeMiniPlayer({
      start,
      direction: "west",
      delta: { x: -50, y: 0 },
      aspect,
      container,
    });
    expect(next.width).toBe(250);
    expect(next.x + next.width).toBe(start.x + start.width);
    expect(next.height - 28).toBeCloseTo(next.width / aspect, 0);
  });

  it("follows the aspect-ratio diagonal from a corner", () => {
    const start = resolveMiniPlayerFrame({
      width: 200,
      position: { x: 100, y: 100 },
      aspect,
      container,
    });
    const next = resizeMiniPlayer({
      start,
      direction: "south-east",
      delta: { x: 20, y: 40 },
      aspect,
      container,
    });
    expect(next.width).toBe(220);
    expect(next.x).toBe(start.x);
    expect(next.y).toBe(start.y);
  });
});
