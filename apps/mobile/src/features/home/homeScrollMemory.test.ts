import { describe, expect, it } from "vite-plus/test";

import { createHomeScrollMemory, homeListFilterKey } from "./homeScrollMemory";

describe("Home scroll memory", () => {
  const unfiltered = homeListFilterKey("", null);

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

    expect(memory.offsetFor("projects", homeListFilterKey("node", null))).toBe(0);
    expect(memory.offsetFor("inbox", homeListFilterKey("", "node-a"))).toBe(0);
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
