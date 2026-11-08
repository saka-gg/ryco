import { describe, expect, it } from "vite-plus/test";

import { createHomeScrollMemory } from "./homeScrollMemory";

describe("Home scroll memory", () => {
  const unfiltered = JSON.stringify(["all", null, null]);

  it("restores each mode's position when its list remounts", () => {
    const memory = createHomeScrollMemory();
    memory.record("inbox", unfiltered, 418);
    memory.record("projects", unfiltered, 230);

    expect(memory.offsetFor("inbox", unfiltered)).toBe(418);
    expect(memory.offsetFor("projects", unfiltered)).toBe(230);
  });

  it("starts changed search results and node scopes at the top without moving the other mode", () => {
    const memory = createHomeScrollMemory();
    memory.record("inbox", unfiltered, 418);
    memory.record("projects", unfiltered, 230);

    expect(memory.offsetFor("projects", JSON.stringify(["all", "node", null]))).toBe(0);
    expect(memory.offsetFor("inbox", JSON.stringify(["all", "node-a", null]))).toBe(0);
    expect(memory.offsetFor("inbox", unfiltered)).toBe(418);
  });

  it("normalizes negative offsets from overscroll", () => {
    const memory = createHomeScrollMemory();
    memory.record("projects", unfiltered, -20);
    expect(memory.offsetFor("projects", unfiltered)).toBe(0);
  });

  it("starts at the top before anything was recorded", () => {
    expect(createHomeScrollMemory().offsetFor("inbox", unfiltered)).toBe(0);
  });
});
