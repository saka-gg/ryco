import { describe, expect, it } from "vite-plus/test";

import { analyzeArtworkPixels, fitArtwork, type ArtworkAnalysis } from "./artworkFit.logic";

type Rgba = readonly [number, number, number, number];
const PURPLE: Rgba = [124, 58, 237, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const INK: Rgba = [24, 24, 27, 255];

/** An RGBA buffer painted per pixel centre; unpainted pixels are transparent. */
function paint(width: number, height: number, at: (x: number, y: number) => Rgba | null) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = at(x + 0.5, y + 0.5);
      if (pixel) rgba.set(pixel, (y * width + x) * 4);
    }
  }
  return { rgba, width, height };
}

const analyze = (image: ReturnType<typeof paint>) =>
  analyzeArtworkPixels(image.rgba, image.width, image.height);

/** Inside a rounded rectangle [x0, x1] x [y0, y1] with corner radius r. */
function inRoundedRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}

/** A thick "L" stroke: a bare glyph on transparency. */
const glyph = (color: Rgba) =>
  paint(64, 64, (x, y) =>
    (x >= 20 && x <= 30 && y >= 12 && y <= 52) || (x >= 20 && x <= 46 && y >= 42 && y <= 52)
      ? color
      : null,
  );

/** A 44px rounded square with a soft drop shadow (alpha 110) 4px below and around it. */
const shadowTile = paint(64, 64, (x, y) => {
  if (inRoundedRect(x, y, 10, 8, 54, 52, 9)) return PURPLE;
  return inRoundedRect(x, y, 6, 8, 58, 60, 13) ? [0, 0, 0, 110] : null;
});

/** A 28px rounded square exported on an opaque white square. */
const mattedTile = paint(64, 64, (x, y) =>
  inRoundedRect(x, y, 18, 18, 46, 46, 6) ? PURPLE : WHITE,
);

/** A black disc with a white letter (a Next.js-style favicon). */
const inkDisc = paint(64, 64, (x, y) => {
  if ((x - 32) ** 2 + (y - 32) ** 2 > 32 ** 2) return null;
  return x > 22 && x < 42 && y > 18 && y < 46 ? WHITE : [0, 0, 0, 255];
});

const fit = (analysis: ArtworkAnalysis | null, naturalWidth = 64, naturalHeight = 64) =>
  fitArtwork({ analysis, naturalWidth, naturalHeight, size: 38, markInset: 6 });

describe("analyzeArtworkPixels", () => {
  it("returns null when nothing is opaque", () => {
    expect(analyze(paint(16, 16, () => [255, 255, 255, 10]))).toBeNull();
  });

  it("reads a full-bleed square as covering its circle", () => {
    const analysis = analyze(paint(32, 32, () => PURPLE))!;
    expect(analysis.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(analysis.body).toEqual(analysis.bounds);
    expect(analysis.coverCoverage).toBe(1);
    expect(analysis.luminance).toBeLessThan(0.2);
  });

  it("trims a rounded square's transparent margin", () => {
    // 64px canvas, an 8px (12.5%) margin, the user's purple tile with a white letter.
    const analysis = analyze(
      paint(64, 64, (x, y) => {
        if (!inRoundedRect(x, y, 8, 8, 56, 56, 11)) return null;
        return x > 26 && x < 38 && y > 20 && y < 44 ? WHITE : PURPLE;
      }),
    )!;
    expect(analysis.bounds).toEqual({ x: 0.125, y: 0.125, width: 0.75, height: 0.75 });
    expect(analysis.body).toEqual(analysis.bounds);
    expect(analysis.coverCoverage).toBeGreaterThan(0.99);
  });

  it("frames a shadowed tile by its solid body, not the shadow's halo", () => {
    const analysis = analyze(shadowTile)!;
    expect(analysis.bounds).toEqual({ x: 6 / 64, y: 8 / 64, width: 52 / 64, height: 52 / 64 });
    expect(analysis.body).toEqual({ x: 10 / 64, y: 8 / 64, width: 44 / 64, height: 44 / 64 });
    expect(analysis.coverCoverage).toBeGreaterThan(0.99);
  });

  it("finds the icon on an opaque matte", () => {
    const analysis = analyze(mattedTile)!;
    expect(analysis.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(analysis.body).toEqual({ x: 18 / 64, y: 18 / 64, width: 28 / 64, height: 28 / 64 });
    expect(analysis.coverCoverage).toBeGreaterThan(0.99);
  });

  it("keeps a full-bleed tile whole: a glyph on its own background is not a matted icon", () => {
    const letter = glyph(WHITE);
    const analysis = analyze(
      paint(64, 64, (x, y) =>
        letter.rgba[(Math.floor(y) * 64 + Math.floor(x)) * 4 + 3] ? WHITE : PURPLE,
      ),
    )!;
    expect(analysis.body).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(analysis.coverCoverage).toBe(1);
  });

  it("keeps a coloured full-bleed tile whole even with a closed glyph on it", () => {
    const ring = (x: number, y: number) => {
      const distance = Math.hypot(x - 32, y - 32);
      return distance >= 14 && distance <= 22;
    };
    const analysis = analyze(paint(64, 64, (x, y) => (ring(x, y) ? WHITE : PURPLE)))!;
    expect(analysis.body).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("reads the tone of a tile's rim apart from the glyph on it", () => {
    const analysis = analyze(inkDisc)!;
    expect(analysis.luminance).toBeGreaterThan(0.03);
    expect(analysis.rimLuminance).toBeLessThan(0.01);
  });

  it("reads a circle as covering its circle", () => {
    const analysis = analyze(
      paint(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 <= 30 ** 2 ? PURPLE : null)),
    )!;
    expect(analysis.coverCoverage).toBeGreaterThan(0.95);
  });

  it("reads a bare glyph as sparse, with its colour's luminance", () => {
    const dark = analyze(glyph(INK))!;
    expect(dark.coverCoverage).toBeLessThan(0.7);
    expect(dark.luminance).toBeLessThan(0.05);
    expect(analyze(glyph(WHITE))!.luminance).toBeCloseTo(1, 5);
  });
});

describe("fitArtwork", () => {
  it("covers the circle with a full-bleed square", () => {
    expect(fit(analyze(paint(64, 64, () => PURPLE)))).toEqual({
      mode: "tile",
      plate: "none",
      ring: false,
      width: 38,
      height: 38,
      left: 0,
      top: 0,
    });
  });

  it("covers the circle with a slightly oblong tile", () => {
    const result = fit(analyze(paint(66, 60, () => PURPLE)), 66, 60);
    expect(result.mode).toBe("tile");
    expect(result.height).toBeCloseTo(38, 5);
    expect(result.width).toBeCloseTo((66 * 38) / 60, 5);
  });

  it("scales a shadowed tile's body to the disc edge, leaving the halo outside", () => {
    const result = fit(analyze(shadowTile));
    expect(result).toMatchObject({ mode: "tile", plate: "none", ring: false });
    const scale = result.width / 64;
    expect(scale).toBeCloseTo(38 / 44, 5);
    expect(result.left + 10 * scale).toBeCloseTo(0, 5);
    expect(result.left + 54 * scale).toBeCloseTo(38, 5);
    expect(result.top + 8 * scale).toBeCloseTo(0, 5);
    expect(result.top + 52 * scale).toBeCloseTo(38, 5);
  });

  it("crops an opaque matte away so the icon on it reaches the disc edge", () => {
    const result = fit(analyze(mattedTile));
    expect(result).toMatchObject({ mode: "tile", plate: "none", ring: false });
    const scale = result.width / 64;
    expect(scale).toBeCloseTo(38 / 28, 5);
    expect(result.left + 18 * scale).toBeCloseTo(0, 5);
    expect(result.top + 46 * scale).toBeCloseTo(38, 5);
  });

  it("rings a dark tile so the disc keeps its edge on the island", () => {
    expect(fit(analyze(inkDisc))).toMatchObject({ mode: "tile", plate: "none", ring: true });
  });

  it("zooms past a rounded square's margin so its content box covers the circle", () => {
    const analysis = analyze(
      paint(64, 64, (x, y) => (inRoundedRect(x, y, 8, 8, 56, 56, 11) ? PURPLE : null)),
    );
    const result = fit(analysis);
    expect(result.mode).toBe("tile");
    expect(result.plate).toBe("none");
    // The 48px content box scales to 38px; the 64px image overflows the circle.
    expect(result.width).toBeCloseTo((64 * 38) / 48, 5);
    expect(result.height).toBeCloseTo((64 * 38) / 48, 5);
    expect(result.left).toBeCloseTo(-8 * (38 / 48), 5);
    expect(result.top).toBeCloseTo(-8 * (38 / 48), 5);
  });

  it("covers the circle with a round icon", () => {
    const result = fit(
      analyze(paint(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 <= 32 ** 2 ? INK : null))),
    );
    expect(result.mode).toBe("tile");
    expect(result.ring).toBe(true);
    expect(result.width).toBeCloseTo(38, 5);
  });

  it("insets a dark glyph on a light plate", () => {
    const result = fit(analyze(glyph(INK)));
    expect(result.mode).toBe("mark");
    expect(result.plate).toBe("light");
    expect(result.ring).toBe(false);
    // The 26x40 content box is contained in 26px, centred in the circle.
    const scale = 26 / 40;
    expect(result.width).toBeCloseTo(64 * scale, 5);
    expect(result.left + (20 + 26 / 2) * scale).toBeCloseTo(19, 5);
    expect(result.top + (12 + 40 / 2) * scale).toBeCloseTo(19, 5);
  });

  it("insets a white glyph on a dark plate so it stays visible", () => {
    const result = fit(analyze(glyph(WHITE)));
    expect(result.mode).toBe("mark");
    expect(result.plate).toBe("dark");
  });

  it("contains a wide wordmark by its width", () => {
    // Three separate letters across a 160x40 image.
    const wordmark = paint(160, 40, (x, y) =>
      y >= 8 && y <= 32 && ((x >= 4 && x <= 14) || (x >= 74 && x <= 84) || (x >= 146 && x <= 156))
        ? INK
        : null,
    );
    const result = fit(analyze(wordmark), 160, 40);
    expect(result.mode).toBe("mark");
    const scale = 26 / 152;
    expect(result.width).toBeCloseTo(160 * scale, 5);
    expect(result.left + 80 * scale).toBeCloseTo(19, 5);
  });

  it("contains a solid wide banner whole instead of cropping its sides", () => {
    const result = fit(analyze(paint(150, 50, () => PURPLE)), 150, 50);
    expect(result).toMatchObject({ mode: "mark", plate: "light", width: 26, left: 6 });
    expect(result.height).toBeCloseTo(26 / 3, 5);
  });

  it("insets a solid dark bar on the light plate", () => {
    const bar = paint(64, 64, (x, y) => (x >= 20 && x <= 44 && y >= 10 && y <= 54 ? INK : null));
    const result = fit(analyze(bar));
    expect(result).toMatchObject({ mode: "mark", plate: "light", ring: false });
    // The 24x44 bar is contained by its height.
    expect(result.height).toBeCloseTo((64 * 26) / 44, 5);
  });

  it("contains the whole image on the light plate when its pixels are unreadable", () => {
    expect(fit(null, 128, 64)).toEqual({
      mode: "mark",
      plate: "light",
      ring: false,
      width: 26,
      height: 13,
      left: 6,
      top: 12.5,
    });
  });
});
