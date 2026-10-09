import { describe, expect, it } from "vite-plus/test";

import { fitArtwork } from "../lib/artworkFit.logic";
import { readArtworkAnalysis } from "../lib/readArtwork";
import { loadArtworkImage, type ArtworkSample } from "./projectArtworkTestFixtures";

const analyze = async (sample: ArtworkSample) =>
  readArtworkAnalysis(await loadArtworkImage(sample));

const fitFor = async (sample: ArtworkSample) => {
  const image = await loadArtworkImage(sample);
  return fitArtwork({
    analysis: readArtworkAnalysis(image),
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    size: 38,
    markInset: 6,
  });
};

describe("readArtworkAnalysis", () => {
  it("trims a rounded square's transparent margin and sees it covers its circle", async () => {
    const analysis = (await analyze("tile"))!;
    expect(analysis.bounds.x).toBeCloseTo(8 / 64, 2);
    expect(analysis.bounds.y).toBeCloseTo(8 / 64, 2);
    expect(analysis.bounds.width).toBeCloseTo(48 / 64, 2);
    expect(analysis.bounds.height).toBeCloseTo(48 / 64, 2);
    expect(analysis.coverCoverage).toBeGreaterThan(0.98);
    // The white letter lifts the purple's mean, still well short of a light mark.
    expect(analysis.luminance).toBeLessThan(0.6);
  });

  it("reads an opaque square and a circle as covering their circle", async () => {
    const square = (await analyze("square"))!;
    expect(square.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(square.coverCoverage).toBe(1);
    expect((await analyze("circle"))!.coverCoverage).toBeGreaterThan(0.95);
  });

  it("reads a bare glyph as sparse, dark or light", async () => {
    const dark = (await analyze("darkGlyph"))!;
    expect(dark.coverCoverage).toBeLessThan(0.9);
    expect(dark.luminance).toBeLessThan(0.1);
    const white = (await analyze("whiteGlyph"))!;
    expect(white.coverCoverage).toBeLessThan(0.9);
    expect(white.luminance).toBeGreaterThan(0.9);
    // The glyph's box is trimmed to the letter, well inside the image.
    expect(white.bounds.width).toBeLessThan(0.6);
  });

  it("frames each sample: tiles fill the circle, glyphs sit on a contrasting plate", async () => {
    const tile = await fitFor("tile");
    expect(tile).toMatchObject({ mode: "tile", plate: "none" });
    // Zoomed past the margin: the image is larger than the circle and starts above-left of it.
    expect(tile.width).toBeGreaterThan(48);
    expect(tile.left).toBeLessThan(-4);
    expect(await fitFor("square")).toMatchObject({ mode: "tile", width: 38, left: 0 });
    expect(await fitFor("circle")).toMatchObject({ mode: "tile", plate: "none" });
    expect(await fitFor("darkGlyph")).toMatchObject({ mode: "mark", plate: "light" });
    expect(await fitFor("whiteGlyph")).toMatchObject({ mode: "mark", plate: "dark" });
  });

  it("frames a shadowed tile and a matted tile by their body, a dark tile with a ring", async () => {
    for (const [sample, body] of [
      ["shadowTile", { x: 10, y: 8, side: 44 }],
      ["mattedTile", { x: 18, y: 18, side: 28 }],
    ] as const) {
      const fit = await fitFor(sample);
      expect(fit).toMatchObject({ mode: "tile", plate: "none", ring: false });
      // The body (not the shadow or the matte) spans the 38px disc, to within a sampled pixel.
      const scale = fit.width / 64;
      expect(scale * body.side).toBeGreaterThan(37);
      expect(scale * body.side).toBeLessThan(40);
      expect(Math.abs(fit.left + body.x * scale)).toBeLessThan(1.5);
      expect(Math.abs(fit.top + body.y * scale)).toBeLessThan(1.5);
    }
    expect(await fitFor("inkDisc")).toMatchObject({ mode: "tile", ring: true });
  });

  it("returns null for an image with nothing to sample", () => {
    expect(readArtworkAnalysis(new Image())).toBeNull();
  });
});
