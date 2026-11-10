/** Zoom and pan of an expanded image, inside the box it fits at 100%. */
export interface ImageZoomState {
  /** 1 is the image fitted to its box. */
  readonly scale: number;
  /** Pan from the centre, in screen pixels. */
  readonly x: number;
  readonly y: number;
}

export const IMAGE_ZOOM_MIN = 1;
export const IMAGE_ZOOM_MAX = 8;
const IMAGE_ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4, 6, 8];

export function clampImageZoom(scale: number): number {
  if (!Number.isFinite(scale)) return IMAGE_ZOOM_MIN;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, scale));
}

export function stepImageZoom(scale: number, direction: 1 | -1): number {
  const current = clampImageZoom(scale);
  if (direction === 1)
    return IMAGE_ZOOM_STEPS.find((step) => step > current + 0.01) ?? IMAGE_ZOOM_MAX;
  return IMAGE_ZOOM_STEPS.findLast((step) => step < current - 0.01) ?? IMAGE_ZOOM_MIN;
}

/** Keeps the zoomed image covering its box: no edge comes inside it. */
export function clampImageOffset(
  state: ImageZoomState,
  box: { readonly width: number; readonly height: number },
): ImageZoomState {
  const maxX = (box.width * (state.scale - 1)) / 2;
  const maxY = (box.height * (state.scale - 1)) / 2;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(-max, value));
  return { scale: state.scale, x: clamp(state.x, maxX), y: clamp(state.y, maxY) };
}

/**
 * Zooms to `scale` keeping the image point under `point` (relative to the
 * box's centre) where it is. Back at 100% the image is centred again.
 */
export function zoomImageAt(
  state: ImageZoomState,
  scale: number,
  point: { readonly x: number; readonly y: number },
  box: { readonly width: number; readonly height: number },
): ImageZoomState {
  const next = clampImageZoom(scale);
  if (next === IMAGE_ZOOM_MIN) return { scale: IMAGE_ZOOM_MIN, x: 0, y: 0 };
  const ratio = next / state.scale;
  return clampImageOffset(
    {
      scale: next,
      x: point.x - (point.x - state.x) * ratio,
      y: point.y - (point.y - state.y) * ratio,
    },
    box,
  );
}
