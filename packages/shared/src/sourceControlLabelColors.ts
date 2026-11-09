/**
 * A host label's color (GitHub's "d73a4a") as the tint every client draws its
 * chip with: a faint fill, a stronger border, and text lifted toward white so
 * it stays legible on a dark page.
 */

export interface LabelChipColors {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly color: string;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX6 = /^[0-9a-fA-F]{6}$/u;

function parseHex(color: string | undefined): Rgb | null {
  if (!color) return null;
  const trimmed = color.replace(/^#/u, "").trim();
  if (!HEX6.test(trimmed)) return null;
  return {
    r: Number.parseInt(trimmed.slice(0, 2), 16),
    g: Number.parseInt(trimmed.slice(2, 4), 16),
    b: Number.parseInt(trimmed.slice(4, 6), 16),
  };
}

function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Per WCAG-style relative luminance, returns 0..1.
function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

// Lift dark colors toward white so text stays legible against the (often dark) page bg.
function readableTextColor(rgb: Rgb): Rgb {
  const lum = relativeLuminance(rgb);
  if (lum >= 0.4) return rgb;
  const lift = Math.min(0.7, (0.4 - lum) * 1.6);
  return {
    r: Math.round(rgb.r + (255 - rgb.r) * lift),
    g: Math.round(rgb.g + (255 - rgb.g) * lift),
    b: Math.round(rgb.b + (255 - rgb.b) * lift),
  };
}

/** The chip's colors for a host label color; null for a missing or malformed one (draw it neutral). */
export function labelChipColors(color: string | undefined): LabelChipColors | null {
  const rgb = parseHex(color);
  if (rgb === null) return null;
  const text = readableTextColor(rgb);
  return {
    backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
    borderColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`,
    color: `rgb(${text.r}, ${text.g}, ${text.b})`,
  };
}
