import { describe, expect, it } from "vite-plus/test";
import { adjacentDiffFileIndex, visibleDiffFileIndex } from "./useDiffFileNavigation";

describe("changed-file navigation", () => {
  it("clamps empty, single-file and list boundaries", () => {
    expect(adjacentDiffFileIndex(0, -1, 1)).toBeNull();
    expect(adjacentDiffFileIndex(1, 0, 1)).toBeNull();
    expect(adjacentDiffFileIndex(3, 0, -1)).toBeNull();
    expect(adjacentDiffFileIndex(3, 2, 1)).toBeNull();
    expect(adjacentDiffFileIndex(3, 1, -1)).toBe(0);
    expect(adjacentDiffFileIndex(3, 1, 1)).toBe(2);
  });
  it("finds the file crossing the viewport top with logarithmic layout reads", () => {
    let reads = 0;
    expect(
      visibleDiffFileIndex(
        1024,
        (i) => {
          reads++;
          return i * 100;
        },
        52050,
      ),
    ).toBe(520);
    expect(reads).toBeLessThanOrEqual(11);
    expect(visibleDiffFileIndex(0, () => 0, 0)).toBe(-1);
    expect(visibleDiffFileIndex(3, (i) => i * 100, -10)).toBe(0);
  });
});
