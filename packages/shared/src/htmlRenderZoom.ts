/**
 * Zoom of an agent's HTML page shown at full size (the expanded view and the
 * workspace panel's page tab). It works the way browser zoom does: the page's
 * sandboxed frame is laid out `zoom` times narrower than its box and scaled up
 * to fill it, so a responsive page reflows and a fixed-width page grows or
 * shrinks. Nothing here touches the page itself.
 */

export const HTML_RENDER_ZOOM_MIN = 0.25;
export const HTML_RENDER_ZOOM_MAX = 4;

/** The levels the buttons and keys step through: the browser's own. */
export const HTML_RENDER_ZOOM_STEPS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];

export function clampHtmlRenderZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(HTML_RENDER_ZOOM_MAX, Math.max(HTML_RENDER_ZOOM_MIN, zoom));
}

/** The next step above (1) or below (-1) `zoom`; a zoom between steps goes to the nearest one that way. */
export function stepHtmlRenderZoom(zoom: number, direction: 1 | -1): number {
  const current = clampHtmlRenderZoom(zoom);
  // A pinch can land a hair off a step; that counts as the step.
  const tolerance = 0.005;
  if (direction === 1) {
    return (
      HTML_RENDER_ZOOM_STEPS.find((step) => step > current + tolerance) ?? HTML_RENDER_ZOOM_MAX
    );
  }
  return (
    HTML_RENDER_ZOOM_STEPS.findLast((step) => step < current - tolerance) ?? HTML_RENDER_ZOOM_MIN
  );
}

/**
 * The zoom after a Ctrl+wheel or a trackpad pinch: smooth and proportional,
 * so a pinch feels continuous, while one notch of a mouse wheel moves about
 * one step. Positive `deltaY` zooms out.
 */
export function wheelHtmlRenderZoom(zoom: number, deltaY: number): number {
  const factor = Math.min(1.25, Math.max(0.8, Math.exp(-deltaY / 250)));
  return clampHtmlRenderZoom(zoom * factor);
}

/** The zoom after a pinch that reports its own scale factor (WebKit). */
export function scaleHtmlRenderZoom(zoom: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return clampHtmlRenderZoom(zoom);
  return clampHtmlRenderZoom(zoom * Math.min(1.5, Math.max(0.67, factor)));
}

/** How a page reports its width: what it needs, and the width it is laid out at. */
export interface HtmlRenderContentWidth {
  readonly width: number;
  readonly viewportWidth: number;
}

/**
 * The zoom that shows the page's full width in a box `boxWidth` wide, never
 * above 100%: a page that fits stays at 100%. `content` is the page's latest
 * report, made at the zoom it was laid out at (`zoom`). Returns null when the
 * report cannot tell: the page fits at a narrow zoom, and only a report at
 * 100% says whether it fits there too.
 */
export function fitHtmlRenderZoom(input: {
  readonly boxWidth: number;
  readonly zoom: number;
  readonly content: HtmlRenderContentWidth | undefined;
}): number | null {
  const { boxWidth, content } = input;
  if (!(boxWidth > 0)) return null;
  if (content === undefined) return null;
  // Wider than its frame: at a frame as wide as the page needs, it fits.
  if (content.width > content.viewportWidth + 1) {
    return clampHtmlRenderZoom(Math.min(1, boxWidth / content.width));
  }
  // It fits at this zoom; at 100% the frame is as wide or wider, so it fits there too.
  if (input.zoom >= 1 - 1e-3) return 1;
  return null;
}

/** "125%": the zoom as a reader reads it. */
export function formatHtmlRenderZoom(zoom: number): string {
  return `${Math.round(clampHtmlRenderZoom(zoom) * 100)}%`;
}

/**
 * How the page's frame sits in its box at `zoom`: laid out at the box size
 * divided by the zoom, then scaled up from its top-left corner to fill it.
 */
export function htmlRenderZoomFrameStyle(zoom: number): {
  readonly width: string;
  readonly height: string;
  readonly transform: string | undefined;
  readonly transformOrigin: string;
} {
  const value = clampHtmlRenderZoom(zoom);
  if (Math.abs(value - 1) < 1e-3) {
    return { width: "100%", height: "100%", transform: undefined, transformOrigin: "0 0" };
  }
  const percent = `${(100 / value).toFixed(4)}%`;
  return {
    width: percent,
    height: percent,
    transform: `scale(${value})`,
    transformOrigin: "0 0",
  };
}
