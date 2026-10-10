/** A pixel counts as artwork from this alpha up; softer pixels are anti-aliasing or shadow. */
const OPAQUE_ALPHA = 24;
/** A pixel this opaque is the artwork's solid body; a soft drop shadow stays below it. */
const BODY_ALPHA = 192;
/** An opaque border this uniform (per channel, of 255) is a matte the artwork sits on. */
const MATTE_TOLERANCE = 8;
/** A pixel this far from the matte's colour (in any channel) stops the matte. */
const MATTE_CONTRAST = 24;
/**
 * A matte is a neutral (white, grey or black) export background; a coloured
 * border is a designed tile's own background, kept whole even when a closed
 * glyph (an "O") on it would look like an icon on a matte.
 */
const MATTE_MAX_CHROMA = 24;
/** The rim whose tone decides a tile's ring: the outer band of its circle, from this radius. */
const RIM_INNER_RADIUS = 0.85;
/** A cover-cropped circle this full means the artwork brings its own background. */
const TILE_COVERAGE = 0.9;
/** A tile's body is at most this elongated; a wider (or taller) one would lose its sides. */
const TILE_MAX_ASPECT = 1.25;
/** A tile whose rim is darker than this (relative luminance) vanishes into the dark island. */
const DARK_RIM_LUMINANCE = 0.03;
/** A mark brighter than this (relative luminance) sits on a dark plate, else a light one. */
const LIGHT_MARK_LUMINANCE = 0.6;

/** A box normalised to 0..1 of the image. */
export interface ArtworkBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What an image's pixels say about how to frame it in a circle. */
export interface ArtworkAnalysis {
  /** The content box: transparent margins (and only those) trimmed. */
  readonly bounds: ArtworkBox;
  /**
   * The solid body a tile is framed by: the content box without a soft drop
   * shadow, or an icon inside an opaque matte (a logo exported on white).
   */
  readonly body: ArtworkBox;
  /**
   * Share of solid pixels inside the centred circle of diameter
   * min(width, height) of the body: what a cover crop to a circle shows.
   */
  readonly coverCoverage: number;
  /** Mean relative luminance (0..1) of the content, weighted by alpha. */
  readonly luminance: number;
  /** Mean relative luminance of the solid pixels on the outer rim of that circle. */
  readonly rimLuminance: number;
}

/**
 * How to place artwork in a circle. A tile (an icon with its own background)
 * covers the circle edge to edge, with a ring when its edge is too dark to
 * show on the island; a mark (a bare glyph, or anything that is not a
 * square-ish tile) is contained within an inset on a plate that contrasts
 * with it.
 */
export interface ArtworkFit {
  readonly mode: "tile" | "mark";
  readonly plate: "none" | "light" | "dark";
  readonly ring: boolean;
  /** The absolutely positioned image's box inside the circle, in px. */
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/** sRGB channel (0..255) to linear light, for relative luminance. */
const LINEAR_CHANNEL = Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

function pixelLuminance(rgba: Uint8ClampedArray, offset: number): number {
  return (
    0.2126 * LINEAR_CHANNEL[rgba[offset]!]! +
    0.7152 * LINEAR_CHANNEL[rgba[offset + 1]!]! +
    0.0722 * LINEAR_CHANNEL[rgba[offset + 2]!]!
  );
}

/** An inclusive pixel box that grows to fit what it is shown. */
class PixelBox {
  minX = Infinity;
  minY = Infinity;
  maxX = -1;
  maxY = -1;
  add(x: number, y: number) {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }
  get empty() {
    return this.maxX < 0;
  }
  get width() {
    return this.maxX - this.minX + 1;
  }
  get height() {
    return this.maxY - this.minY + 1;
  }
  normalised(width: number, height: number): ArtworkBox {
    return {
      x: this.minX / width,
      y: this.minY / height,
      width: this.width / width,
      height: this.height / height,
    };
  }
}

/** Reads an RGBA buffer (as from `getImageData`); null when no pixel is opaque. */
export function analyzeArtworkPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): ArtworkAnalysis | null {
  const content = new PixelBox();
  const solid = new PixelBox();
  let alphaSum = 0;
  let luminanceSum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const alpha = rgba[offset + 3]!;
      if (alpha < OPAQUE_ALPHA) continue;
      content.add(x, y);
      if (alpha >= BODY_ALPHA) solid.add(x, y);
      alphaSum += alpha;
      luminanceSum += alpha * pixelLuminance(rgba, offset);
    }
  }
  if (content.empty) return null;

  // Translucent artwork has no solid body; its content box stands in.
  const alphaBody = solid.empty
    ? { box: content, isSolid: (offset: number) => rgba[offset + 3]! >= OPAQUE_ALPHA }
    : { box: solid, isSolid: (offset: number) => rgba[offset + 3]! >= BODY_ALPHA };
  const alphaCircle = measureCircle(rgba, width, alphaBody.box, alphaBody.isSolid);
  const matted = findMattedTile(rgba, width, height);
  const body = matted ?? { ...alphaBody, ...alphaCircle };

  return {
    bounds: content.normalised(width, height),
    body: body.box.normalised(width, height),
    coverCoverage: body.coverage,
    luminance: luminanceSum / alphaSum,
    rimLuminance: body.rimLuminance ?? luminanceSum / alphaSum,
  };
}

/**
 * Coverage of `isSolid` pixels in the circle inscribed in `box`, and the mean
 * luminance of those on its outer rim (null when the rim has none).
 */
function measureCircle(
  rgba: Uint8ClampedArray,
  width: number,
  box: PixelBox,
  isSolid: (offset: number) => boolean,
) {
  const radius = Math.min(box.width, box.height) / 2;
  const rimRadius = radius * RIM_INNER_RADIUS;
  const centerX = box.minX + box.width / 2;
  const centerY = box.minY + box.height / 2;
  let inside = 0;
  let solid = 0;
  let rim = 0;
  let rimLuminanceSum = 0;
  for (let y = Math.floor(centerY - radius); y < Math.ceil(centerY + radius); y++) {
    for (let x = Math.floor(centerX - radius); x < Math.ceil(centerX + radius); x++) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > radius * radius) continue;
      inside++;
      const offset = (y * width + x) * 4;
      if (!isSolid(offset)) continue;
      solid++;
      if (distanceSquared < rimRadius * rimRadius) continue;
      rim++;
      rimLuminanceSum += pixelLuminance(rgba, offset);
    }
  }
  return {
    // A body under one pixel across still has its one solid pixel.
    coverage: inside === 0 ? 1 : solid / inside,
    rimLuminance: rim === 0 ? null : rimLuminanceSum / rim,
  };
}

/**
 * An icon tile exported on an opaque matte (a logo on white): the image's
 * border is one opaque neutral colour, and what that colour does not reach from the
 * border (the tile, glyphs inside it included) fills its own circle. Null
 * otherwise, including for a full-bleed tile with a glyph on it, whose border
 * is its own background.
 */
function findMattedTile(rgba: Uint8ClampedArray, width: number, height: number) {
  if (width < 3 || height < 3) return null;
  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
  const mean = [0, 0, 0];
  for (const index of border) {
    if (rgba[index * 4 + 3] !== 255) return null;
    for (let channel = 0; channel < 3; channel++) mean[channel]! += rgba[index * 4 + channel]!;
  }
  for (let channel = 0; channel < 3; channel++) mean[channel]! /= border.length;
  const distance = (index: number) =>
    Math.max(
      Math.abs(rgba[index * 4]! - mean[0]!),
      Math.abs(rgba[index * 4 + 1]! - mean[1]!),
      Math.abs(rgba[index * 4 + 2]! - mean[2]!),
    );
  if (Math.max(...mean) - Math.min(...mean) > MATTE_MAX_CHROMA) return null;
  if (border.some((index) => distance(index) > MATTE_TOLERANCE)) return null;

  // Flood the matte in from the border: matte-coloured pixels it reaches.
  const matte = new Uint8Array(width * height);
  const queue = border;
  for (const index of queue) matte[index] = 1;
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!;
    const x = index % width;
    for (const next of [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      index - width,
      index + width,
    ]) {
      if (next < 0 || next >= matte.length || matte[next]) continue;
      if (rgba[next * 4 + 3] !== 255 || distance(next) > MATTE_CONTRAST) continue;
      matte[next] = 1;
      queue.push(next);
    }
  }

  const isSolid = (offset: number) => matte[offset / 4] === 0;
  const box = new PixelBox();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (!matte[y * width + x]) box.add(x, y);
  }
  if (box.empty) return null;
  const circle = measureCircle(rgba, width, box, isSolid);
  return circle.coverage >= TILE_COVERAGE ? { box, ...circle } : null;
}

/** The whole image, for artwork whose pixels could not be read. */
const WHOLE_IMAGE: ArtworkBox = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Places an image in a `size` px circle. Without an analysis (a cross-origin
 * image whose pixels cannot be read) the whole image is contained on the light
 * plate: legible whatever it shows.
 */
export function fitArtwork(input: {
  readonly analysis: ArtworkAnalysis | null;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly size: number;
  readonly markInset: number;
}): ArtworkFit {
  const { analysis, size } = input;
  // An image without intrinsic size (some SVGs) is stretched over a square.
  const naturalWidth = input.naturalWidth > 0 ? input.naturalWidth : 1;
  const naturalHeight = input.naturalHeight > 0 ? input.naturalHeight : 1;
  const markBox = Math.max(0, size - 2 * input.markInset);
  // Scales the image by `scale` with `box` centred in the circle.
  const place = (box: ArtworkBox, scale: number) => ({
    width: naturalWidth * scale,
    height: naturalHeight * scale,
    left: size / 2 - (box.x + box.width / 2) * naturalWidth * scale,
    top: size / 2 - (box.y + box.height / 2) * naturalHeight * scale,
  });
  const contain = (box: ArtworkBox) =>
    place(
      box,
      Math.min(markBox / (box.width * naturalWidth), markBox / (box.height * naturalHeight)),
    );

  if (analysis === null) {
    return { mode: "mark", plate: "light", ring: false, ...contain(WHOLE_IMAGE) };
  }
  const bodyWidth = analysis.body.width * naturalWidth;
  const bodyHeight = analysis.body.height * naturalHeight;
  const bodySide = Math.min(bodyWidth, bodyHeight);
  if (
    Math.max(bodyWidth, bodyHeight) <= TILE_MAX_ASPECT * bodySide &&
    analysis.coverCoverage >= TILE_COVERAGE
  ) {
    return {
      mode: "tile",
      plate: "none",
      ring: analysis.rimLuminance < DARK_RIM_LUMINANCE,
      ...place(analysis.body, size / bodySide),
    };
  }
  return {
    mode: "mark",
    plate: analysis.luminance < LIGHT_MARK_LUMINANCE ? "light" : "dark",
    ring: false,
    ...contain(analysis.bounds),
  };
}
